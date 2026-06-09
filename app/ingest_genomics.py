"""
ingest_genomics.py — ingest 1000 Genomes DRAGEN VCF files into IceChunk Zarr.

Mirrors ingest_uk.py for the weather project. Reads per-sample VCF.gz files
from the public s3://1000genomes-dragen bucket via pysam HTTP range requests,
aggregates allele frequencies across the cohort, and writes population-level
1D arrays to an IceChunk repository on S3.

IceChunk Zarr schema per chromosome:
  chr22/
    position      (int32,   n_variants)  ← sorted VCF POS
    allele_freq   (float32, n_variants)  ← fraction with ≥1 ALT allele
    het_rate      (float32, n_variants)  ← fraction heterozygous
    variant_type  (int8,    n_variants)  ← 0=SNP, 1=INS, 2=DEL, 3=MNP
    ref_len       (int8,    n_variants)  ← len(REF)
    alt_len       (int8,    n_variants)  ← len(ALT[0])

Call ingest_genomics(chroms=['chr22']) to ingest a single chromosome.
Default (chroms=None) ingests all autosomes + X.
"""

from __future__ import annotations

import concurrent.futures
import gzip
import io
import logging
import os
import re
import struct
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import zarr
from botocore import UNSIGNED
from botocore.config import Config
import boto3

from icechunk_client import open_or_create_genomics_repo

logger = logging.getLogger(__name__)

# ── Source data ───────────────────────────────────────────────────────────────

SRC_HTTPS = "https://1000genomes-dragen.s3.amazonaws.com"
DRAGEN_PATH = "data/dragen-3.7.6/hg38-graph-based"
META_KEY = "metadata/igsr-1000-genomes-30x-on-grch38.tsv"
SRC_BUCKET = "1000genomes-dragen"
SRC_REGION = "us-east-1"

# Default chromosomes (V1: chr22 only for speed; add more after validation)
DEFAULT_CHROMS = ["chr22"]

# All autosomes + X for full ingestion
ALL_CHROMS = [f"chr{i}" for i in range(1, 23)] + ["chrX"]

# hg38 chromosome lengths — used to pre-allocate numpy aggregation arrays
CHROM_LENGTHS: dict[str, int] = {
    "chr1": 248_956_422, "chr2": 242_193_529, "chr3": 198_295_559,
    "chr4": 190_214_555, "chr5": 181_538_259, "chr6": 170_805_979,
    "chr7": 159_345_973, "chr8": 145_138_636, "chr9": 138_394_717,
    "chr10": 133_797_422, "chr11": 135_086_622, "chr12": 133_275_309,
    "chr13": 114_364_328, "chr14": 107_043_718, "chr15": 101_991_189,
    "chr16": 90_338_345,  "chr17": 83_257_441,  "chr18": 80_373_148,
    "chr19": 58_617_616,  "chr20": 64_444_167,  "chr21": 46_709_983,
    "chr22": 50_818_468,  "chrX": 156_040_895,  "chrY": 57_227_415,
}

# Zarr chunk size for 1D genomic arrays
CHUNK_SIZE = 10_000

# Max parallel VCF readers — limited by network + memory
MAX_WORKERS = int(os.environ.get("INGEST_WORKERS", "16"))

# Variant type encoding
VTYPE_SNP = 0
VTYPE_INS = 1
VTYPE_DEL = 2
VTYPE_MNP = 3


# ── Helpers ───────────────────────────────────────────────────────────────────

def _s3():
    return boto3.client(
        "s3", region_name=SRC_REGION,
        config=Config(signature_version=UNSIGNED),
    )


def _load_sample_ids() -> list[str]:
    """Return all sample IDs available in the hg38-graph-based build."""
    s3 = _s3()
    paginator = s3.get_paginator("list_objects_v2")
    prefix = f"{DRAGEN_PATH}/"
    samples = []
    for page in paginator.paginate(Bucket=SRC_BUCKET, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            name = cp["Prefix"].rstrip("/").split("/")[-1]
            if name and name not in ("teslogs",):
                samples.append(name)
    return sorted(samples)


def _classify_variant(ref: str, alt: str) -> int:
    r, a = len(ref), len(alt)
    if r == 1 and a == 1:
        return VTYPE_SNP
    if a > r:
        return VTYPE_INS
    if a < r:
        return VTYPE_DEL
    return VTYPE_MNP


# ── Per-sample VCF reader ─────────────────────────────────────────────────────

def _tbi_chrom_range(tbi_bytes: bytes, chrom: str) -> tuple[int, int]:
    """
    Parse a TBI index file and return (start_byte, end_byte) of the compressed
    VCF data for the given chromosome.

    Uses the LINEAR INDEX (16Kbp intervals array), not the bin index.
    The linear index gives a much tighter range than bins (6 MB vs 400 MB for chr22).

    TBI files are bgzf-compressed; decompresses to raw binary before parsing.
    """
    raw = _decompress_bgzf_bytes(tbi_bytes)
    buf = io.BytesIO(raw)

    magic = buf.read(4)
    if magic != b'TBI\x01':
        raise ValueError(f"Not a TBI file after decompression (magic={magic!r})")

    n_ref = struct.unpack('<i', buf.read(4))[0]
    buf.read(6 * 4)                              # skip format, col_seq/beg/end, meta, skip
    l_nm = struct.unpack('<i', buf.read(4))[0]
    names = buf.read(l_nm).rstrip(b'\x00').split(b'\x00')
    names = [n.decode('utf-8', errors='replace') for n in names]

    if chrom not in names:
        raise ValueError(f"Chromosome {chrom!r} not in TBI. Available: {names[:5]}")
    chrom_idx = names.index(chrom)

    # Read all bins + intervals per chromosome in order
    all_intervals: list[list[int]] = []
    for _ in range(n_ref):
        n_bin = struct.unpack('<i', buf.read(4))[0]
        for _ in range(n_bin):
            buf.read(4)                                         # skip bin_id
            n_chunk = struct.unpack('<i', buf.read(4))[0]
            buf.read(n_chunk * 16)                              # skip chunks
        n_intv = struct.unpack('<i', buf.read(4))[0]
        ioffs  = [struct.unpack('<Q', buf.read(8))[0] for _ in range(n_intv)]
        all_intervals.append(ioffs)

    # Start: first non-zero virtual file offset (VFO) for target chromosome
    target_ioffs = all_intervals[chrom_idx]
    start_vfo = next((x for x in target_ioffs if x > 0), None)
    if start_vfo is None:
        raise ValueError(f"No interval data for {chrom!r}")
    start_byte = start_vfo >> 16

    # End: first non-zero VFO of the following chromosome (or +50 MB fallback)
    next_idx = chrom_idx + 1
    end_byte: int
    if next_idx < len(all_intervals) and any(x > 0 for x in all_intervals[next_idx]):
        end_vfo  = next(x for x in all_intervals[next_idx] if x > 0)
        end_byte = (end_vfo >> 16) + 65536   # add one block of slack
    else:
        end_byte = start_byte + 50_000_000   # chr22 is last; 50 MB is ample

    return start_byte, end_byte


def _decompress_bgzf_bytes(data: bytes) -> bytes:
    """
    Decompress concatenated bgzf blocks into raw bytes.
    Each bgzf block is an independent gzip member.
    """
    out = []
    buf = io.BytesIO(data)
    while True:
        header = buf.read(18)
        if len(header) < 18:
            break
        if header[0:2] != b'\x1f\x8b':
            break
        bsize_minus_1 = struct.unpack('<H', header[16:18])[0]
        block_size    = bsize_minus_1 + 1
        rest          = buf.read(block_size - 18)
        if len(rest) < block_size - 18:
            break
        block = header + rest
        try:
            out.append(gzip.decompress(block))
        except Exception:
            break
    return b''.join(out)


def _decompress_bgzf(data: bytes) -> str:
    """Decompress bgzf blocks into a UTF-8 string."""
    return _decompress_bgzf_bytes(data).decode('utf-8', errors='replace')


def _parse_vcf_gt(line: str, chrom: str) -> Optional[tuple[int, int, int, int]]:
    """
    Parse one VCF line and return (pos, n_alt, vtype, ref_len).
    Expects single-sample VCF (DRAGEN output).
    Returns None for header lines, wrong-chrom lines, or ref-only calls.
    """
    if not line or line[0] == '#':
        return None
    parts = line.split('\t', 10)
    if len(parts) < 10 or parts[0] != chrom:
        return None
    _, pos_str, _, ref, alt_str, _, _, _, fmt, sample = parts[:10]
    if not alt_str or alt_str == '.':
        return None
    try:
        pos = int(pos_str)
    except ValueError:
        return None
    # Parse GT
    fmt_keys = fmt.split(':')
    sample_vals = sample.split(':')
    try:
        gt_idx = fmt_keys.index('GT')
        gt_alleles = re.split(r'[/|]', sample_vals[gt_idx])
        n_alt = sum(1 for a in gt_alleles if a not in ('.', '0'))
    except (ValueError, IndexError):
        n_alt = 0
    alts = alt_str.split(',')
    vtype = _classify_variant(ref, alts[0])
    return (pos, n_alt, vtype, len(ref))


def _read_sample_variants(sample_id: str, chrom: str) -> list[tuple[int, int, int, int]]:
    """
    Download chr22 (or any chrom) VCF data for one sample via boto3 S3 range request.

    Uses the TBI index to find the exact byte range, so only a small fraction
    of the 408 MB VCF.gz file is downloaded (~3–8 MB per sample for chr22).
    boto3 is used instead of pysam HTTP because libcurl (used by htslib) does
    not route through SPCS's EAI proxy, causing silent hangs.
    """
    import time
    s3      = _s3()
    pfx     = f"{DRAGEN_PATH}/{sample_id}/{sample_id}.hard-filtered"
    key_vcf = f"{pfx}.vcf.gz"
    key_tbi = f"{pfx}.vcf.gz.tbi"
    try:
        t0 = time.time()
        tbi_bytes         = s3.get_object(Bucket=SRC_BUCKET, Key=key_tbi)['Body'].read()
        t1 = time.time()
        start, end        = _tbi_chrom_range(tbi_bytes, chrom)
        range_header      = f"bytes={start}-{end}"
        t2 = time.time()
        vcf_bytes         = s3.get_object(Bucket=SRC_BUCKET, Key=key_vcf,
                                          Range=range_header)['Body'].read()
        t3 = time.time()
        text              = _decompress_bgzf(vcf_bytes)
        rows = []
        for line in text.splitlines():
            result = _parse_vcf_gt(line, chrom)
            if result is not None:
                rows.append(result)
        t4 = time.time()
        if len(rows) > 0:  # Log timing for first successful sample
            logger.debug(f"[ingest] {sample_id}: tbi={t1-t0:.2f}s range={t3-t2:.2f}s "
                         f"parse={t4-t3:.2f}s rows={len(rows)}")
        return rows
    except Exception as e:
        logger.warning(f"[ingest] {sample_id}/{chrom}: {e}")
        return []


# ── Chromosome aggregation ────────────────────────────────────────────────────

def _aggregate_chromosome(
    chrom: str,
    samples: list[str],
    max_workers: int = MAX_WORKERS,
) -> dict:
    """
    Aggregate variant data for one chromosome across all samples.

    Uses pre-allocated numpy arrays indexed directly by genomic position
    instead of a Python dict. This is ~100× faster for the aggregation step
    because numpy integer increments release the GIL and avoid Python object
    overhead (~300 bytes/entry in a dict vs. 2 bytes/slot in a numpy array).

    Memory: 5 arrays × chrom_length × 2 bytes ≈ 500 MB for chr22 (50 Mbp).
    Well within CPU_X64_L's 64 GB.

    Returns dict of sorted 1D numpy arrays:
      position, allele_freq, het_rate, variant_type, ref_len
    """
    chrom_len = CHROM_LENGTHS.get(chrom, 300_000_000)

    # Pre-allocate numpy arrays indexed by position (0 to chrom_len).
    # int16 supports up to 32,767 samples — fine for 3,201.
    het_counts  = np.zeros(chrom_len + 1, dtype=np.int16)
    hom_counts  = np.zeros(chrom_len + 1, dtype=np.int16)
    vtype_arr_full = np.zeros(chrom_len + 1, dtype=np.int8)   # variant type per pos
    rlen_arr_full  = np.zeros(chrom_len + 1, dtype=np.int16)  # ref len per pos

    n = len(samples)
    logger.info(f"[ingest] {chrom}: reading {n} samples ({max_workers} workers)…")

    def _accumulate(sample_id: str):
        return _read_sample_variants(sample_id, chrom)

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(_accumulate, sid): sid for sid in samples}
        for fut in concurrent.futures.as_completed(futs):
            rows = fut.result()
            if rows:
                # Vectorised numpy update — far faster than per-element Python dict ops
                positions_arr = np.array([r[0] for r in rows], dtype=np.int32)
                n_alts_arr    = np.array([r[1] for r in rows], dtype=np.int8)
                vtype_row     = np.array([r[2] for r in rows], dtype=np.int8)
                rlen_row      = np.array([r[3] for r in rows], dtype=np.int16)

                het_mask = n_alts_arr == 1
                hom_mask = n_alts_arr >= 2

                # np.add.at is unbuffered accumulation — safe for repeated positions
                np.add.at(het_counts,  positions_arr[het_mask], 1)
                np.add.at(hom_counts,  positions_arr[hom_mask], 1)

                # Record variant type + ref_len at each position (last writer wins)
                vtype_arr_full[positions_arr] = vtype_row
                rlen_arr_full[positions_arr]  = rlen_row

            completed += 1
            if completed % 10 == 0 or completed == n:
                occupied = int(np.count_nonzero(het_counts + hom_counts))
                logger.info(f"[ingest] {chrom}: {completed}/{n} samples done, "
                            f"{occupied:,} variant positions so far")

    # Extract only positions that have at least one ALT allele across cohort
    occupied_mask = (het_counts + hom_counts) > 0
    positions = np.where(occupied_mask)[0].astype(np.int32)   # already sorted!
    n_vars = len(positions)

    if n_vars == 0:
        return {}

    het_arr = het_counts[positions].astype(np.int32)
    hom_arr = hom_counts[positions].astype(np.int32)

    allele_freq = np.minimum((2.0 * hom_arr + het_arr) / (2.0 * n), 1.0).astype(np.float32)
    het_rate    = (het_arr / n).astype(np.float32)
    vtype_out   = vtype_arr_full[positions]
    rlen_out    = rlen_arr_full[positions]

    logger.info(f"[ingest] {chrom}: {n_vars:,} unique variant positions "
                f"(max AF={allele_freq.max():.3f})")

    return {
        "position":     positions,
        "allele_freq":  allele_freq,
        "het_rate":     het_rate,
        "variant_type": vtype_out,
        "ref_len":      rlen_out,
    }


# ── Write to IceChunk Zarr ────────────────────────────────────────────────────

def _write_chromosome(
    root: zarr.Group,
    chrom: str,
    arrays: dict,
    sample_count: int,
) -> None:
    """Write chromosome arrays to the IceChunk Zarr root group."""
    n_vars = len(arrays["position"])
    chunks = (min(CHUNK_SIZE, n_vars),)

    if chrom in root:
        # Overwrite existing group
        del root[chrom]

    grp = root.require_group(chrom)

    # Zarr v3: data= and dtype= cannot be combined — dtype is inferred from the numpy array
    grp.create_array("position",     data=arrays["position"],     chunks=chunks, overwrite=True)
    grp.create_array("allele_freq",  data=arrays["allele_freq"],  chunks=chunks, overwrite=True)
    grp.create_array("het_rate",     data=arrays["het_rate"],     chunks=chunks, overwrite=True)
    grp.create_array("variant_type", data=arrays["variant_type"], chunks=chunks, overwrite=True)
    grp.create_array("ref_len",      data=arrays["ref_len"],      chunks=chunks, overwrite=True)

    grp.attrs.update({
        "n_variants":   n_vars,
        "n_samples":    sample_count,
        "chrom":        chrom,
        "variables":    ["allele_freq", "het_rate", "variant_type", "ref_len"],
        "pos_min":      int(arrays["position"].min()),
        "pos_max":      int(arrays["position"].max()),
    })

    logger.info(f"[ingest] {chrom}: wrote {n_vars:,} variants to Zarr")


# ── Public API ────────────────────────────────────────────────────────────────

def ingest_genomics(
    chroms: Optional[list[str]] = None,
    sample_ids: Optional[list[str]] = None,
    max_workers: int = MAX_WORKERS,
) -> dict:
    """
    Ingest 1000 Genomes DRAGEN variants into IceChunk on S3.

    Args:
        chroms:     List of chromosomes to ingest. Defaults to ['chr22'].
        sample_ids: List of sample IDs to include. Defaults to all 3,202.
        max_workers: Number of parallel VCF readers.

    Returns dict with ingestion summary.
    """
    target_chroms = chroms or DEFAULT_CHROMS

    logger.info("[ingest] Loading sample list from S3…")
    if sample_ids:
        samples = sample_ids
    else:
        samples = _load_sample_ids()
        logger.info(f"[ingest] Found {len(samples)} samples in hg38-graph-based build")

    repo = open_or_create_genomics_repo()

    summary = {
        "chromosomes": [],
        "sample_count": len(samples),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    # Commit per-chromosome so progress is durable and each chromosome becomes
    # queryable as soon as it finishes (important for long genome-wide runs).
    for chrom in target_chroms:
        logger.info(f"[ingest] === Processing {chrom} ===")
        arrays = _aggregate_chromosome(chrom, samples, max_workers=max_workers)
        if not arrays:
            logger.warning(f"[ingest] {chrom}: no variants found, skipping")
            continue
        session = repo.writable_session("main")
        root = zarr.open_group(session.store, mode="a")
        _write_chromosome(root, chrom, arrays, len(samples))
        snapshot_id = session.commit(
            message=f"Ingested {chrom} from {len(samples)} DRAGEN samples"
        )
        try:
            repo.create_tag(
                f"{chrom}_v1_{len(samples)}samples_"
                + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                snapshot_id,
            )
        except Exception as e:
            logger.warning(f"[ingest] {chrom}: tag failed (non-fatal): {e}")
        summary["chromosomes"].append({
            "chrom":    chrom,
            "n_vars":   int(len(arrays["position"])),
            "pos_min":  int(arrays["position"].min()),
            "pos_max":  int(arrays["position"].max()),
            "snapshot": str(snapshot_id),
        })
        logger.info(f"[ingest] {chrom}: committed snapshot {snapshot_id}")

    summary["finished_at"] = datetime.now(timezone.utc).isoformat()
    logger.info(f"[ingest] Done. Chromosomes: {[c['chrom'] for c in summary['chromosomes']]}")
    return summary
