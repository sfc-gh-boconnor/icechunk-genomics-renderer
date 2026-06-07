"""
GRAGEN Service — FastAPI backend for the 1000 Genomes DRAGEN Genomics Accelerator.

Data is stored in an IceChunk Zarr repository on S3 (mirroring the IceChunk
weather project). VCF files from the public 1000genomes-dragen bucket are
ingested by ingest_genomics.py into 1D Zarr arrays per chromosome:
  position      (int32)   ← sorted VCF POS (coordinate, like lat/lon)
  allele_freq   (float32) ← cohort AF (data variable, like air_temperature)
  het_rate      (float32) ← fraction heterozygous
  variant_type  (int8)    ← 0=SNP 1=INS 2=DEL 3=MNP
  ref_len       (int8)    ← len(REF)

Endpoints:
  GET  /health                       → liveness probe
  GET  /meta                         → dataset info (chroms, sample count, snapshots)
  POST /slice                        → Snowflake external function wire format
  POST /direct/variants              → direct SPCS-internal slice (bypasses SF 20 MB limit)
  POST /seed_genomics                → trigger VCF→IceChunk ingest
  GET  /samples                      → list of samples with population metadata
  GET  /direct/metrics/{sample_id}   → QC metrics for one sample
"""

from __future__ import annotations

import csv
import io
import logging
import os
import threading
from contextlib import asynccontextmanager
from typing import Any, Optional

import boto3
import numpy as np
import zarr
from botocore import UNSIGNED
from botocore.config import Config
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from icechunk_client import open_or_create_genomics_repo, open_genomics_repo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

SRC_BUCKET   = "1000genomes-dragen"
SRC_REGION   = "us-east-1"
SRC_HTTPS    = "https://1000genomes-dragen.s3.amazonaws.com"
DRAGEN_PATH  = "data/dragen-3.7.6/hg38-graph-based"

MAX_VARIANTS_RESPONSE = 200_000   # hard cap: ~20 MB Snowflake ext fn limit
MAX_DIRECT_VARIANTS   = 1_000_000 # direct path — no Snowflake limit

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

VTYPE_LABELS = {0: "SNP", 1: "INS", 2: "DEL", 3: "MNP"}

SUPERPOP_COLORS = {
    "AFR": [230, 60,  60],
    "AMR": [230, 130, 40],
    "EAS": [60,  180, 60],
    "EUR": [60,  120, 220],
    "SAS": [160, 60,  200],
}

# ── Repo cache ────────────────────────────────────────────────────────────────

_repo = None
_repo_lock = threading.Lock()

def _get_repo():
    global _repo
    with _repo_lock:
        if _repo is None:
            _repo = open_or_create_genomics_repo()
    return _repo

def _get_root() -> zarr.Group:
    """Open the IceChunk store at the latest snapshot."""
    repo = _get_repo()
    session = repo.readonly_session("main")
    return zarr.open_group(session.store, mode="r")

# ── Sample metadata cache ─────────────────────────────────────────────────────

_samples_cache: list[dict] | None = None
_samples_lock  = threading.Lock()

def _load_sample_metadata() -> list[dict]:
    global _samples_cache
    with _samples_lock:
        if _samples_cache is not None:
            return _samples_cache
        logger.info("[meta] Loading sample metadata from public S3…")
        s3  = boto3.client("s3", region_name=SRC_REGION,
                           config=Config(signature_version=UNSIGNED))
        obj = s3.get_object(Bucket=SRC_BUCKET,
                            Key="metadata/igsr-1000-genomes-30x-on-grch38.tsv")
        raw = obj["Body"].read().decode("utf-8")
        reader = csv.DictReader(io.StringIO(raw), delimiter="\t")
        samples = []
        for row in reader:
            name = (row.get("#Sample name") or row.get("Sample name") or "").strip()
            if not name:
                continue
            samples.append({
                "sample_id":       name,
                "sex":             row.get("Sex", "").strip(),
                "population":      row.get("Population code", "").strip(),
                "pop_name":        row.get("Population name", "").strip(),
                "superpopulation": row.get("Superpopulation code", "").strip(),
                "superpop_name":   row.get("Superpopulation name", "").strip(),
            })
        _samples_cache = samples
        logger.info(f"[meta] Loaded {len(samples)} samples.")
        return _samples_cache

# ── Zarr slice helpers ────────────────────────────────────────────────────────
# Mirrors _slice_2d_curvilinear() from the weather project — same concept,
# but 1D (genomic position) instead of 2D (lat × lon grid).

def _slice_genomic(
    root: zarr.Group,
    chrom: str,
    start: int,
    end: int,
    variable: str = "allele_freq",
    max_variants: int = MAX_VARIANTS_RESPONSE,
) -> dict:
    """
    Slice variants from a chromosome Zarr group by position range.

    Uses np.searchsorted on sorted positions for O(log n) range lookup —
    no full array scan needed, analogous to the lat/lon mask in the weather
    project but for 1D sorted coordinates.
    """
    chrom = chrom if chrom.startswith("chr") else f"chr{chrom}"

    if chrom not in root:
        available = sorted(root.keys())
        raise HTTPException(400, f"Chromosome {chrom} not in IceChunk store. "
                                  f"Ingested: {available or 'none yet — run seed_genomics first'}")

    grp = root[chrom]
    variables = list(grp.attrs.get("variables", ["allele_freq", "het_rate",
                                                  "variant_type", "ref_len"]))

    if variable not in variables and variable not in ("position",):
        raise HTTPException(400, f"Unknown variable '{variable}'. Available: {variables}")

    positions = np.array(grp["position"][:])

    # O(log n) range search on sorted positions
    lo = int(np.searchsorted(positions, start,   side="left"))
    hi = int(np.searchsorted(positions, end + 1, side="left"))
    n_in_range = hi - lo

    if n_in_range == 0:
        return {"data": [], "row_count": 0, "variable": variable,
                "chrom": chrom, "start": start, "end": end}

    # Auto-downsample if over cap (mirrors weather stride logic)
    stride = 1
    if n_in_range > max_variants:
        stride = max(1, n_in_range // max_variants)

    pos_slice  = positions[lo:hi:stride]
    val_slice  = np.array(grp[variable][lo:hi:stride])
    type_slice = np.array(grp["variant_type"][lo:hi:stride]) if "variant_type" in grp else None

    rows = [
        {
            "pos":   int(pos_slice[i]),
            "value": round(float(val_slice[i]), 6),
            "type":  int(type_slice[i]) if type_slice is not None else 0,
        }
        for i in range(len(pos_slice))
    ]

    # Build density histogram for large regions (like weather density chart)
    density = None
    region_size = end - start
    if region_size > 100_000 and len(rows) > 0:
        n_bins = min(2000, max(100, region_size // 50_000))
        bin_size = region_size / n_bins
        counts = np.zeros(n_bins, dtype=np.int32)
        for r in rows:
            b = min(int((r["pos"] - start) / bin_size), n_bins - 1)
            counts[b] += 1
        density = [
            {"pos": int(start + i * bin_size), "count": int(counts[i])}
            for i in range(n_bins) if counts[i] > 0
        ]

    return {
        "data":       rows,
        "row_count":  len(rows),
        "variable":   variable,
        "chrom":      chrom,
        "start":      start,
        "end":        end,
        "n_in_range": n_in_range,
        "stride":     stride,
        "density":    density,
        "variables":  variables,
    }

# ── Lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("GRAGEN service starting — connecting to IceChunk repo")
    try:
        root = _get_root()
        ingested = sorted(root.keys())
        logger.info(f"IceChunk store ready. Chromosomes: {ingested or 'empty (run seed_genomics)'}")
    except Exception as e:
        logger.warning(f"IceChunk store not ready yet: {e}")
    yield
    logger.info("GRAGEN service shutting down")

app = FastAPI(title="GRAGEN Service", version="1.0.1", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

# ── Models ────────────────────────────────────────────────────────────────────

class VariantRequest(BaseModel):
    chrom:    str
    start:    int
    end:      int
    variable: str = "allele_freq"
    max_variants: int = 50_000

class SeedRequest(BaseModel):
    chroms:     Optional[list[str]] = None   # default: ["chr22"]
    sample_ids: Optional[list[str]] = None   # default: all 3,202
    max_workers: int = 16

# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.1"}

@app.get("/meta")
def meta():
    """Dataset metadata: chromosomes in store, sample count, snapshots."""
    samples = _load_sample_metadata()
    pop_counts: dict[str, int] = {}
    for s in samples:
        sp = s.get("superpopulation", "?")
        pop_counts[sp] = pop_counts.get(sp, 0) + 1

    chrom_info: dict[str, dict] = {}
    try:
        root = _get_root()
        for chrom in sorted(root.keys()):
            grp = root[chrom]
            attrs = dict(grp.attrs) if hasattr(grp, "attrs") else {}
            chrom_info[chrom] = {
                "n_variants": attrs.get("n_variants", 0),
                "n_samples":  attrs.get("n_samples",  0),
                "variables":  attrs.get("variables",  []),
                "pos_min":    attrs.get("pos_min",     0),
                "pos_max":    attrs.get("pos_max",     0),
            }
    except Exception:
        pass

    return {
        "sample_count":     len(samples),
        "superpopulations": pop_counts,
        "superpop_colors":  SUPERPOP_COLORS,
        "chromosomes_in_store": chrom_info,
        "chrom_lengths":    CHROM_LENGTHS,
        "dragen_version":   "3.7.6",
        "reference":        "hg38-graph-based",
        "data_source":      f"s3://{SRC_BUCKET}",
    }

@app.get("/samples")
def samples(superpop: Optional[str] = None,
            pop: Optional[str] = None,
            limit: int = 5000):
    all_samples = _load_sample_metadata()
    result = all_samples
    if superpop:
        result = [s for s in result if s["superpopulation"] == superpop.upper()]
    if pop:
        result = [s for s in result if s["population"] == pop.upper()]
    return {"samples": result[:limit], "total": len(all_samples)}

@app.post("/direct/variants")
def direct_variants(req: VariantRequest):
    """
    Direct SPCS-internal slice — no Snowflake 20 MB limit.
    Returns allele frequency (or other variable) for all variants in region.
    """
    try:
        root = _get_root()
    except Exception as e:
        raise HTTPException(503, f"IceChunk store not available: {e}. Run /seed_genomics first.")

    result = _slice_genomic(
        root, req.chrom, req.start, req.end,
        variable=req.variable,
        max_variants=min(req.max_variants, MAX_DIRECT_VARIANTS),
    )
    return {
        "chrom":      result["chrom"],
        "start":      result["start"],
        "end":        result["end"],
        "count":      result["row_count"],
        "n_in_range": result["n_in_range"],
        "stride":     result["stride"],
        "variables":  result["variables"],
        "variants":   result["data"],
        "density":    result["density"],
        "truncated":  result["stride"] > 1,
    }

@app.post("/slice")
def slice_variants(body: dict):
    """
    Snowflake external function endpoint (wire format).
    Input:  { "data": [[row_num, chrom, start, end], ...] }
    Output: { "data": [[row_num, result_variant], ...] }
    """
    rows = body.get("data", [])
    results = []

    try:
        root = _get_root()
    except Exception as e:
        for row in rows:
            results.append([row[0], {"error": f"Store not ready: {e}"}])
        return {"data": results}

    for row in rows:
        row_num = row[0]
        try:
            chrom    = str(row[1])
            start    = int(row[2])
            end      = int(row[3])
            variable = str(row[4]) if len(row) > 4 else "allele_freq"
            result   = _slice_genomic(root, chrom, start, end, variable,
                                       max_variants=MAX_VARIANTS_RESPONSE)
            results.append([row_num, result])
        except Exception as e:
            results.append([row_num, {"error": str(e)}])
    return {"data": results}

@app.post("/seed_genomics")
def seed_genomics(req: SeedRequest):
    """
    Trigger VCF → IceChunk ingest pipeline.
    Mirrors /seed_uk from the weather project.
    """
    logger.info(f"[seed] Starting genomics ingest: chroms={req.chroms}, "
                f"workers={req.max_workers}")
    try:
        from ingest_genomics import ingest_genomics
        result = ingest_genomics(
            chroms=req.chroms,
            sample_ids=req.sample_ids,
            max_workers=req.max_workers,
        )
        # Invalidate repo cache so next read gets the new snapshot
        global _repo
        with _repo_lock:
            _repo = None
        logger.info(f"[seed] Ingest complete: {result}")
        return result
    except Exception as e:
        logger.exception("Genomics ingest failed")
        raise HTTPException(500, f"Ingest failed: {e}")

@app.get("/direct/metrics/{sample_id}")
def direct_metrics(sample_id: str):
    """Read QC metrics for a single sample from the public S3 bucket."""
    import pysam
    from botocore import UNSIGNED
    from botocore.config import Config as BotoConfig

    s3 = boto3.client("s3", region_name=SRC_REGION,
                      config=Config(signature_version=UNSIGNED))
    base_key = f"{DRAGEN_PATH}/{sample_id}/{sample_id}"

    mapping_metrics: dict[str, Any] = {}
    vc_metrics:      dict[str, Any] = {}

    try:
        obj = s3.get_object(Bucket=SRC_BUCKET, Key=f"{base_key}.mapping_metrics.csv")
        csv_text = obj["Body"].read().decode("utf-8")
        for line in csv_text.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 4:
                continue
            key, val = parts[2], parts[3]
            if key == "Average alignment coverage over genome":
                try: mapping_metrics["mean_coverage"] = float(val)
                except ValueError: pass
            elif key == "Number of duplicate marked reads":
                try: mapping_metrics["dup_reads"] = int(val)
                except ValueError: pass
            elif key == "Total input reads":
                try: mapping_metrics["total_reads"] = int(val)
                except ValueError: pass
            elif key == "Mapped reads":
                try: mapping_metrics["mapped_reads"] = int(val)
                except ValueError: pass
        if mapping_metrics.get("dup_reads") and mapping_metrics.get("total_reads"):
            mapping_metrics["pct_duplicates"] = round(
                mapping_metrics["dup_reads"] / mapping_metrics["total_reads"] * 100, 2)
        if mapping_metrics.get("mapped_reads") and mapping_metrics.get("total_reads"):
            mapping_metrics["pct_mapped"] = round(
                mapping_metrics["mapped_reads"] / mapping_metrics["total_reads"] * 100, 2)
    except Exception as e:
        logger.warning(f"[metrics] mapping_metrics for {sample_id}: {e}")

    try:
        obj = s3.get_object(Bucket=SRC_BUCKET, Key=f"{base_key}.vc_metrics.csv")
        csv_text = obj["Body"].read().decode("utf-8")
        for line in csv_text.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 4:
                continue
            key, val = parts[2], parts[3]
            if key == "SNPs":
                try: vc_metrics["snp_count"] = int(val)
                except ValueError: pass
            elif key in ("Insertions (Hom)", "Insertions (Het)"):
                try: vc_metrics["ins_count"] = vc_metrics.get("ins_count", 0) + int(val)
                except ValueError: pass
            elif key in ("Deletions (Hom)", "Deletions (Het)"):
                try: vc_metrics["del_count"] = vc_metrics.get("del_count", 0) + int(val)
                except ValueError: pass
            elif key == "Ti/Tv ratio":
                try: vc_metrics["titv_ratio"] = float(val)
                except ValueError: pass
            elif key == "Heterozygous":
                try: vc_metrics["het_count"] = int(val)
                except ValueError: pass
            elif key == "Homozygous":
                try: vc_metrics["hom_count"] = int(val)
                except ValueError: pass
            elif key == "Total":
                try: vc_metrics["total_variants"] = int(val)
                except ValueError: pass
        if vc_metrics.get("het_count") and vc_metrics.get("hom_count", 0) > 0:
            vc_metrics["het_hom_ratio"] = round(
                vc_metrics["het_count"] / vc_metrics["hom_count"], 3)
    except Exception as e:
        logger.warning(f"[metrics] vc_metrics for {sample_id}: {e}")

    # Enrich with population metadata
    meta_map = {s["sample_id"]: s for s in _load_sample_metadata()}
    pop_info = meta_map.get(sample_id, {})
    return {**mapping_metrics, **vc_metrics, **pop_info, "sample_id": sample_id}
