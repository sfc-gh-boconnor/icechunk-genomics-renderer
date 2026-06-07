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
import os
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pysam
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


# ── Per-chromosome ingest ──────────────────────────────────────────────────────

def _ingest_chromosome(chrom: str) -> dict:
    """
    Read ClinVar variants for one chromosome via pysam HTTP range request.
    Returns dict of sorted 1D numpy arrays.

    ClinVar uses 'chr1', 'chr2', ... in GRCh38 VCF (unlike some older builds).
    """
    logger.info(f"[clinvar] Reading {chrom} from {CLINVAR_VCF_URL}…")

    positions: list[int]  = []
    clinsigs:  list[int]  = []
    revstats:  list[int]  = []
    allele_ids: list[int] = []
    ref_lens:  list[int]  = []
    alt_lens:  list[int]  = []

    try:
        with pysam.VariantFile(CLINVAR_VCF_URL, index_filename=CLINVAR_TBI_URL) as vcf:
            for rec in vcf.fetch(chrom):
                info = rec.info
                clnsig    = info.get("CLNSIG",    "")
                revstat   = info.get("CLNREVSTAT", "")
                allele_id = info.get("ALLELEID",   0)
                alts      = rec.alts or (".",)

                # CLNSIG in pysam is a tuple — join to string
                if isinstance(clnsig, (list, tuple)):
                    clnsig = "|".join(str(x) for x in clnsig)
                if isinstance(revstat, (list, tuple)):
                    revstat = ",_".join(str(x) for x in revstat)

                positions.append(rec.pos)
                clinsigs.append(_encode_clinsig(str(clnsig)))
                revstats.append(_encode_revstat(str(revstat)))
                allele_ids.append(int(allele_id) if allele_id else 0)
                ref_lens.append(min(len(rec.ref), 127))
                alt_lens.append(min(len(alts[0]) if alts else 1, 127))
    except Exception as e:
        logger.error(f"[clinvar] Error reading {chrom}: {e}")
        raise

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
    grp.create_array("position",  data=arrays["position"],  chunks=chunks, dtype=np.int32, overwrite=True)
    grp.create_array("clinsig",   data=arrays["clinsig"],   chunks=chunks, dtype=np.int8,  overwrite=True)
    grp.create_array("revstat",   data=arrays["revstat"],   chunks=chunks, dtype=np.int8,  overwrite=True)
    grp.create_array("allele_id", data=arrays["allele_id"], chunks=chunks, dtype=np.int32, overwrite=True)
    grp.create_array("ref_len",   data=arrays["ref_len"],   chunks=chunks, dtype=np.int8,  overwrite=True)
    grp.create_array("alt_len",   data=arrays["alt_len"],   chunks=chunks, dtype=np.int8,  overwrite=True)

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
