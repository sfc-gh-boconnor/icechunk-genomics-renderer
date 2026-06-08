"""
ingest_clinvar.py — ingest ClinVar VCF into IceChunk Zarr.

Mirrors ingest_genomics.py — reads the ClinVar VCF.gz directly from
NCBI's public HTTPS endpoint via pysam HTTP range requests (no full
download), and writes per-chromosome 1D arrays to an IceChunk repository
on S3.

IceChunk Zarr schema per chromosome:
  chr22/
    position    (int32,  n_variants)  ← sorted VCF POS
    clinsig     (int8,   n_variants)  ← encoded clinical significance
    revstat     (int8,   n_variants)  ← review status confidence
    allele_id   (int32,  n_variants)  ← ClinVar allele ID
    ref_len     (int8,   n_variants)  ← len(REF) for variant type
    alt_len     (int8,   n_variants)  ← len(ALT[0]) for variant type

Clinical significance encoding:
  0 = Benign
  1 = Likely_benign
  2 = Uncertain_significance / VUS
  3 = Likely_pathogenic
  4 = Pathogenic
  5 = Conflicting_interpretations
  6 = Not_provided / Other

Review status encoding (confidence level):
  0 = no_assertion
  1 = criteria_provided_single_submitter
  2 = criteria_provided_multiple_submitters
  3 = reviewed_by_expert_panel
  4 = practice_guideline

Note: ClinVar VCF uses chromosome names without 'chr' prefix (1, 2, …, X).
      We add the prefix on ingest so it matches the 1000G genomics_repo.
"""

from __future__ import annotations

import logging
import gzip
import io
import logging
import os
import re
import struct
import urllib.request
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import zarr

from icechunk_client import open_or_create_clinvar_repo

logger = logging.getLogger(__name__)

# ── Source ─────────────────────────────────────────────────────────────────────

CLINVAR_VCF_URL = "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz"
CLINVAR_TBI_URL = CLINVAR_VCF_URL + ".tbi"

DEFAULT_CHROMS = ["chr22"]
ALL_CHROMS     = [f"chr{i}" for i in range(1, 23)] + ["chrX"]

CHUNK_SIZE = 10_000

# ── Significance / review status encoding ──────────────────────────────────────

CLINSIG_LABELS = ["Benign", "Likely_benign", "Uncertain_significance",
                   "Likely_pathogenic", "Pathogenic",
                   "Conflicting_interpretations", "Other"]

REVSTAT_LABELS = ["no_assertion",
                  "criteria_provided_single_submitter",
                  "criteria_provided_multiple_submitters",
                  "reviewed_by_expert_panel",
                  "practice_guideline"]

_CLINSIG_MAP: dict[str, int] = {
    "benign":                                 0,
    "likely_benign":                          1,
    "uncertain_significance":                 2,
    "vus":                                    2,
    "likely_pathogenic":                      3,
    "pathogenic":                             4,
    "conflicting_interpretations_of_pathogenicity": 5,
    "conflicting_classifications_of_pathogenicity": 5,
    "conflicting_interpretations":            5,
}

_REVSTAT_MAP: dict[str, int] = {
    "no_assertion_provided":                          0,
    "no_assertion_criteria_provided":                 0,
    "no_classification_provided":                     0,
    "criteria_provided,_single_submitter":            1,
    "criteria_provided,_conflicting_classifications": 1,
    "criteria_provided,_multiple_submitters,_no_conflicts": 2,
    "reviewed_by_expert_panel":                       3,
    "practice_guideline":                             4,
}


def _encode_clinsig(raw: str) -> int:
    if not raw:
        return 6
    # ClinVar CLNSIG can be pipe-separated for multi-allelic
    parts = [p.strip().lower().replace(" ", "_") for p in raw.split("|")]
    # Find the most severe classification
    best = 6
    for p in parts:
        best = min(best, _CLINSIG_MAP.get(p, 6))
        # "most severe" = pathogenic (4) > likely_pathogenic (3) > vus (2) > ...
        # Use max numeric value (higher = more severe)
    vals = [_CLINSIG_MAP.get(p, 6) for p in parts if p in _CLINSIG_MAP]
    return max(vals) if vals else 6


def _encode_revstat(raw: str) -> int:
    if not raw:
        return 0
    return _REVSTAT_MAP.get(raw.strip().lower(), 0)


def _http_range(url: str, start: int, end: int) -> bytes:
    """Download a byte range from a URL via urllib."""
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def _tbi_chrom_range(tbi_bytes: bytes, chrom: str) -> tuple[int, int]:
    """Parse bgzf-compressed TBI and return (start_byte, end_byte) for chrom."""
    def _decompress(data: bytes) -> bytes:
        out = []
        buf = io.BytesIO(data)
        while True:
            h = buf.read(18)
            if len(h) < 18 or h[:2] != b'\x1f\x8b':
                break
            bsize = struct.unpack('<H', h[16:18])[0] + 1
            rest = buf.read(bsize - 18)
            try:
                out.append(gzip.decompress(h + rest))
            except Exception:
                break
        return b''.join(out)

    raw = _decompress(tbi_bytes)
    buf = io.BytesIO(raw)
    if buf.read(4) != b'TBI\x01':
        raise ValueError("Not a TBI file")
    n_ref = struct.unpack('<i', buf.read(4))[0]
    buf.read(24)  # format + col_seq/beg/end + meta + skip
    l_nm = struct.unpack('<i', buf.read(4))[0]
    names = [n.decode() for n in buf.read(l_nm).rstrip(b'\x00').split(b'\x00')]
    if chrom not in names:
        raise ValueError(f"{chrom!r} not in TBI. Available: {names[:5]}")
    chrom_idx = names.index(chrom)

    all_ioffs = []
    for _ in range(n_ref):
        n_bin = struct.unpack('<i', buf.read(4))[0]
        for _ in range(n_bin):
            buf.read(4)  # bin_id
            buf.read(struct.unpack('<i', buf.read(4))[0] * 16)  # chunks
        n_intv = struct.unpack('<i', buf.read(4))[0]
        all_ioffs.append([struct.unpack('<Q', buf.read(8))[0] for _ in range(n_intv)])

    ti = all_ioffs[chrom_idx]
    start_vfo = next((x for x in ti if x > 0), None)
    if start_vfo is None:
        raise ValueError(f"No data for {chrom!r}")
    start = start_vfo >> 16
    next_idx = chrom_idx + 1
    if next_idx < len(all_ioffs) and any(x > 0 for x in all_ioffs[next_idx]):
        end = (next(x for x in all_ioffs[next_idx] if x > 0) >> 16) + 65536
    else:
        end = start + 50_000_000
    return start, end


# ── Per-chromosome ingest ──────────────────────────────────────────────────────

def _ingest_chromosome(chrom: str) -> dict:
    """
    Read ClinVar variants for one chromosome via urllib HTTP range request.

    Uses the TBI index to fetch only the relevant bytes (not the whole ~600 MB file).
    urllib is used instead of pysam because libcurl does not route through SPCS's
    EAI proxy — the same issue we solved for the genomics ingest.
    """
    logger.info(f"[clinvar] Reading {chrom} from {CLINVAR_VCF_URL}…")

    # ClinVar VCF uses bare chromosome names (1, 2, ..., X) not chr-prefixed
    tbi_chrom = chrom.removeprefix("chr")

    # 1. Download TBI index (small)
    tbi_bytes = urllib.request.urlopen(CLINVAR_TBI_URL, timeout=60).read()
    start, end = _tbi_chrom_range(tbi_bytes, tbi_chrom)
    logger.info(f"[clinvar] {chrom}: byte range {start:,}–{end:,} ({(end-start)//1024:,} KB)")

    # 2. Download only the chromosome's bgzf blocks
    vcf_bytes = _http_range(CLINVAR_VCF_URL, start, end)

    # 3. Decompress and parse VCF lines
    def _decompress_bgzf_str(data: bytes) -> str:
        out = []
        buf = io.BytesIO(data)
        while True:
            h = buf.read(18)
            if len(h) < 18 or h[:2] != b'\x1f\x8b':
                break
            bsize = struct.unpack('<H', h[16:18])[0] + 1
            rest = buf.read(bsize - 18)
            try:
                out.append(gzip.decompress(h + rest).decode('utf-8', errors='replace'))
            except Exception:
                break
        return ''.join(out)

    text = _decompress_bgzf_str(vcf_bytes)

    positions: list[int]  = []
    clinsigs:  list[int]  = []
    revstats:  list[int]  = []
    allele_ids: list[int] = []
    ref_lens:  list[int]  = []
    alt_lens:  list[int]  = []

    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        parts = line.split('\t', 9)
        if len(parts) < 8 or parts[0] != tbi_chrom:  # ClinVar uses bare chrom names
            continue
        _, pos_str, _, ref, alt_str, _, _, info_str = parts[:8]
        try:
            pos = int(pos_str)
        except ValueError:
            continue

        # Parse INFO fields
        info: dict = {}
        for kv in info_str.split(';'):
            if '=' in kv:
                k, v = kv.split('=', 1)
                info[k] = v

        clnsig    = info.get('CLNSIG', '')
        revstat   = info.get('CLNREVSTAT', '')
        allele_id = info.get('ALLELEID', '0')
        alts      = alt_str.split(',')

        positions.append(pos)
        clinsigs.append(_encode_clinsig(clnsig))
        revstats.append(_encode_revstat(revstat))
        allele_ids.append(int(allele_id) if allele_id.isdigit() else 0)
        ref_lens.append(min(len(ref), 127))
        alt_lens.append(min(len(alts[0]) if alts else 1, 127))

    if not positions:
        logger.warning(f"[clinvar] {chrom}: no variants found")
        return {}

    # Sort by position (ClinVar VCF should already be sorted, but be safe)
    order = np.argsort(positions)
    pos_arr   = np.array(positions,  dtype=np.int32)[order]
    sig_arr   = np.array(clinsigs,   dtype=np.int8)[order]
    rev_arr   = np.array(revstats,   dtype=np.int8)[order]
    aid_arr   = np.array(allele_ids, dtype=np.int32)[order]
    rlen_arr  = np.array(ref_lens,   dtype=np.int8)[order]
    alen_arr  = np.array(alt_lens,   dtype=np.int8)[order]

    logger.info(f"[clinvar] {chrom}: {len(pos_arr):,} variants "
                f"({sum(sig_arr == 4):,} pathogenic, "
                f"{sum(sig_arr == 3):,} likely_pathogenic)")

    return {
        "position":   pos_arr,
        "clinsig":    sig_arr,
        "revstat":    rev_arr,
        "allele_id":  aid_arr,
        "ref_len":    rlen_arr,
        "alt_len":    alen_arr,
    }


def _write_clinvar_chromosome(root: zarr.Group, chrom: str, arrays: dict) -> None:
    n = len(arrays["position"])
    chunks = (min(CHUNK_SIZE, n),)

    if chrom in root:
        del root[chrom]

    grp = root.require_group(chrom)
    # Zarr v3: data= and dtype= are mutually exclusive — dtype inferred from numpy array
    grp.create_array("position",  data=arrays["position"],  chunks=chunks, overwrite=True)
    grp.create_array("clinsig",   data=arrays["clinsig"],   chunks=chunks, overwrite=True)
    grp.create_array("revstat",   data=arrays["revstat"],   chunks=chunks, overwrite=True)
    grp.create_array("allele_id", data=arrays["allele_id"], chunks=chunks, overwrite=True)
    grp.create_array("ref_len",   data=arrays["ref_len"],   chunks=chunks, overwrite=True)
    grp.create_array("alt_len",   data=arrays["alt_len"],   chunks=chunks, overwrite=True)

    grp.attrs.update({
        "n_variants":       n,
        "chrom":            chrom,
        "variables":        ["clinsig", "revstat", "allele_id", "ref_len", "alt_len"],
        "clinsig_labels":   CLINSIG_LABELS,
        "revstat_labels":   REVSTAT_LABELS,
        "pos_min":          int(arrays["position"].min()),
        "pos_max":          int(arrays["position"].max()),
        "n_pathogenic":     int((arrays["clinsig"] == 4).sum()),
        "n_likely_path":    int((arrays["clinsig"] == 3).sum()),
        "n_vus":            int((arrays["clinsig"] == 2).sum()),
        "n_benign":         int((arrays["clinsig"] == 0).sum()),
    })
    logger.info(f"[clinvar] {chrom}: wrote {n:,} variants to Zarr")


# ── Public API ─────────────────────────────────────────────────────────────────

def ingest_clinvar(chroms: Optional[list[str]] = None) -> dict:
    """
    Ingest ClinVar VCF into IceChunk on S3.

    Args:
        chroms: List of chromosomes to ingest. Defaults to ['chr22'].
                Use ALL_CHROMS for the full genome.

    Returns dict with ingestion summary.
    """
    target_chroms = chroms or DEFAULT_CHROMS
    logger.info(f"[clinvar] Starting ingest for: {target_chroms}")

    repo = open_or_create_clinvar_repo()
    session = repo.writable_session("main")
    root = zarr.open_group(session.store, mode="a")

    summary = {
        "source":      CLINVAR_VCF_URL,
        "chromosomes": [],
        "started_at":  datetime.now(timezone.utc).isoformat(),
    }

    # Store top-level metadata
    root.attrs.update({
        "source":           CLINVAR_VCF_URL,
        "clinsig_labels":   CLINSIG_LABELS,
        "revstat_labels":   REVSTAT_LABELS,
        "ingested_at":      datetime.now(timezone.utc).isoformat(),
    })

    for chrom in target_chroms:
        logger.info(f"[clinvar] === {chrom} ===")
        arrays = _ingest_chromosome(chrom)
        if not arrays:
            continue
        _write_clinvar_chromosome(root, chrom, arrays)
        summary["chromosomes"].append({
            "chrom":         chrom,
            "n_variants":    int(len(arrays["position"])),
            "n_pathogenic":  int((arrays["clinsig"] == 4).sum()),
            "n_likely_path": int((arrays["clinsig"] == 3).sum()),
            "n_vus":         int((arrays["clinsig"] == 2).sum()),
        })

    tag = ("+".join(target_chroms) + "_clinvar_"
           + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    snapshot_id = session.commit(
        message=f"Ingested ClinVar for {', '.join(target_chroms)}"
    )
    repo.create_tag(tag, snapshot_id)

    summary["snapshot_id"] = str(snapshot_id)
    summary["tag"]         = tag
    summary["finished_at"] = datetime.now(timezone.utc).isoformat()

    logger.info(f"[clinvar] Done. Snapshot: {snapshot_id}")
    return summary
