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
import logging
import os
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pysam
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


def _vcf_url(sample_id: str) -> str:
    return f"{SRC_HTTPS}/{DRAGEN_PATH}/{sample_id}/{sample_id}.hard-filtered.vcf.gz"


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

def _read_sample_variants(sample_id: str, chrom: str) -> list[tuple[int, int, int, int]]:
    """
    Read all variants for one sample + chromosome from the remote VCF.
    Returns list of (pos, alt_copies, variant_type, ref_len) tuples.

    alt_copies: 0 = hom_ref, 1 = het, 2 = hom_alt
    Uses pysam HTTP range request via the TBI index (no full download).
    """
    url = _vcf_url(sample_id)
    tbi = url + ".tbi"
    try:
        rows = []
        with pysam.VariantFile(url, index_filename=tbi) as vcf:
            for rec in vcf.fetch(chrom):
                alts = rec.alts or ()
                if not alts:
                    continue
                # Extract genotype for this sample
                try:
                    gt = rec.samples[sample_id]["GT"]
                    n_alt = sum(1 for a in gt if a is not None and a > 0)
                except (KeyError, TypeError):
                    n_alt = 0
                vtype = _classify_variant(rec.ref, alts[0])
                rows.append((rec.pos, n_alt, vtype, len(rec.ref)))
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

    Returns a dict of sorted 1D numpy arrays:
      position, allele_freq, het_rate, variant_type, ref_len
    """
    # position → [hom_ref_count, het_count, hom_alt_count, vtype, ref_len]
    agg: dict[int, list] = {}

    def _accumulate(sample_id: str):
        rows = _read_sample_variants(sample_id, chrom)
        return rows

    n = len(samples)
    logger.info(f"[ingest] {chrom}: reading {n} samples ({max_workers} workers)…")

    completed = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = {ex.submit(_accumulate, sid): sid for sid in samples}
        for fut in concurrent.futures.as_completed(futs):
            sid = futs[fut]
            rows = fut.result()
            for pos, n_alt, vtype, rlen in rows:
                if pos not in agg:
                    agg[pos] = [0, 0, 0, vtype, rlen]  # hom_ref, het, hom_alt
                if n_alt == 0:
                    agg[pos][0] += 1
                elif n_alt == 1:
                    agg[pos][1] += 1
                else:
                    agg[pos][2] += 1
            completed += 1
            if completed % 100 == 0 or completed == n:
                logger.info(f"[ingest] {chrom}: {completed}/{n} samples done, "
                            f"{len(agg):,} unique positions so far")

    # Build sorted arrays
    positions = sorted(agg.keys())
    n_vars = len(positions)
    if n_vars == 0:
        return {}

    pos_arr   = np.array(positions,                                 dtype=np.int32)
    het_arr   = np.array([agg[p][1] for p in positions],           dtype=np.int32)
    hom_arr   = np.array([agg[p][2] for p in positions],           dtype=np.int32)
    vtype_arr = np.array([agg[p][3] for p in positions],           dtype=np.int8)
    rlen_arr  = np.array([agg[p][4] for p in positions],           dtype=np.int8)

    # Fraction of samples with ≥1 ALT allele (het or hom_alt)
    n_with_alt = het_arr + hom_arr
    allele_freq = np.minimum((2.0 * hom_arr + het_arr) / (2.0 * n), 1.0).astype(np.float32)
    het_rate    = (het_arr / n).astype(np.float32)

    logger.info(f"[ingest] {chrom}: {n_vars:,} unique variant positions "
                f"(max AF={allele_freq.max():.3f})")

    return {
        "position":     pos_arr,
        "allele_freq":  allele_freq,
        "het_rate":     het_rate,
        "variant_type": vtype_arr,
        "ref_len":      rlen_arr,
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

    grp.create_array("position",     data=arrays["position"],     chunks=chunks, dtype=np.int32,   overwrite=True)
    grp.create_array("allele_freq",  data=arrays["allele_freq"],  chunks=chunks, dtype=np.float32, overwrite=True)
    grp.create_array("het_rate",     data=arrays["het_rate"],     chunks=chunks, dtype=np.float32, overwrite=True)
    grp.create_array("variant_type", data=arrays["variant_type"], chunks=chunks, dtype=np.int8,    overwrite=True)
    grp.create_array("ref_len",      data=arrays["ref_len"],      chunks=chunks, dtype=np.int8,    overwrite=True)

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
    session = repo.writable_session("main")
    root = zarr.open_group(session.store, mode="a")

    summary = {
        "chromosomes": [],
        "sample_count": len(samples),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }

    for chrom in target_chroms:
        logger.info(f"[ingest] === Processing {chrom} ===")
        arrays = _aggregate_chromosome(chrom, samples, max_workers=max_workers)
        if not arrays:
            logger.warning(f"[ingest] {chrom}: no variants found, skipping")
            continue
        _write_chromosome(root, chrom, arrays, len(samples))
        summary["chromosomes"].append({
            "chrom":    chrom,
            "n_vars":   int(len(arrays["position"])),
            "pos_min":  int(arrays["position"].min()),
            "pos_max":  int(arrays["position"].max()),
        })

    # Commit snapshot
    tag = (
        "+".join(target_chroms) + f"_v1_{len(samples)}samples_"
        + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    )
    snapshot_id = session.commit(
        message=f"Ingested {', '.join(target_chroms)} from {len(samples)} DRAGEN samples"
    )
    repo.create_tag(tag, snapshot_id)

    summary["snapshot_id"] = str(snapshot_id)
    summary["tag"] = tag
    summary["finished_at"] = datetime.now(timezone.utc).isoformat()

    logger.info(f"[ingest] Done. Snapshot: {snapshot_id}, tag: {tag}")
    return summary
