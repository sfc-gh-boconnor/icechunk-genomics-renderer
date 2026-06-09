#!/usr/bin/env python3
"""
build_sample_metrics.py — committed loader for the SAMPLE_METRICS table.

Reproduces the cohort QC table (coverage, Ti/Tv, dup rate, variant counts) plus
population / superpopulation / sex for the 1000 Genomes 30x panel, reading from
the public DRAGEN S3 bucket (us-east-1, unsigned). Mirrors the backend's
/direct/metrics parsing (app/main.py) but in batch.

Sources (all public, no credentials):
  - metadata/igsr-1000-genomes-30x-on-grch38.tsv         (pop / superpop / sex)
  - data/.../<id>/<id>.mapping_metrics.csv                (coverage, reads, dups)
  - data/.../<id>/<id>.vc_metrics.csv                     (SNPs, indels, Ti/Tv, het/hom)

Output: /tmp/sample_metrics.csv  (header, 18 columns in SAMPLE_METRICS order)

Then load with PUT + COPY (see README / SKILL "Load cohort QC metrics"):
  PUT file:///tmp/sample_metrics.csv @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE OVERWRITE=TRUE AUTO_COMPRESS=TRUE;
  COPY INTO GRAGEN_DB.GRAGEN.SAMPLE_METRICS (sample_id,...,het_hom_ratio)
    FROM @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE/sample_metrics.csv
    FILE_FORMAT=(TYPE=CSV SKIP_HEADER=1 FIELD_OPTIONALLY_ENCLOSED_BY='"' EMPTY_FIELD_AS_NULL=TRUE);

Run locally: laptop -> us-east-1 public S3 is direct and the per-sample files
are tiny, so this finishes in a few minutes at 32 workers.
"""
from __future__ import annotations

import concurrent.futures
import csv
import io
import logging
import os
import sys

import boto3
from botocore import UNSIGNED
from botocore.config import Config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s", stream=sys.stdout)
logger = logging.getLogger("build_sample_metrics")

SRC_BUCKET  = "1000genomes-dragen"
SRC_REGION  = "us-east-1"
DRAGEN_PATH = "data/dragen-3.7.6/hg38-graph-based"
META_KEY    = "metadata/igsr-1000-genomes-30x-on-grch38.tsv"

OUT         = "/tmp/sample_metrics.csv"
MAX_WORKERS = int(os.environ.get("METRICS_WORKERS", "32"))

# SAMPLE_METRICS column order (loaded_at has a DEFAULT and is excluded).
COLUMNS = [
    "sample_id", "population", "superpopulation", "sex",
    "mean_coverage", "pct_duplicates", "pct_mapped",
    "total_reads", "mapped_reads", "dup_reads",
    "total_variants", "snp_count", "ins_count", "del_count",
    "titv_ratio", "het_count", "hom_count", "het_hom_ratio",
]


def _s3():
    return boto3.client("s3", region_name=SRC_REGION, config=Config(signature_version=UNSIGNED))


def _load_metadata() -> dict[str, dict]:
    """Return {sample_id: {population, superpopulation, sex}} from the 30x panel TSV."""
    obj = _s3().get_object(Bucket=SRC_BUCKET, Key=META_KEY)
    raw = obj["Body"].read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(raw), delimiter="\t")
    meta: dict[str, dict] = {}
    for row in reader:
        name = (row.get("#Sample name") or row.get("Sample name") or "").strip()
        if not name:
            continue
        meta[name] = {
            "population":      row.get("Population code", "").strip(),
            "superpopulation": row.get("Superpopulation code", "").strip(),
            "sex":             row.get("Sex", "").strip(),
        }
    return meta


def _read_qc(sample_id: str) -> dict:
    """Read mapping_metrics + vc_metrics for one sample. Missing fields stay absent."""
    s3 = _s3()
    base = f"{DRAGEN_PATH}/{sample_id}/{sample_id}"
    m: dict = {}

    try:
        text = s3.get_object(Bucket=SRC_BUCKET, Key=f"{base}.mapping_metrics.csv")["Body"].read().decode("utf-8")
        for line in text.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 4:
                continue
            # Only the sample-level aggregate ("MAPPING/ALIGNING SUMMARY" with an
            # empty read-group). PER RG rows repeat the same keys per lane and would
            # otherwise overwrite the totals with tiny per-lane values.
            if parts[0] != "MAPPING/ALIGNING SUMMARY" or parts[1] != "":
                continue
            key, val = parts[2], parts[3]
            if key == "Average sequenced coverage over genome":
                try: m["mean_coverage"] = float(val)
                except ValueError: pass
            elif key == "Number of duplicate marked reads":
                try: m["dup_reads"] = int(val)
                except ValueError: pass
            elif key == "Total input reads":
                try: m["total_reads"] = int(val)
                except ValueError: pass
            elif key == "Mapped reads":
                try: m["mapped_reads"] = int(val)
                except ValueError: pass
        if m.get("dup_reads") and m.get("total_reads"):
            m["pct_duplicates"] = round(m["dup_reads"] / m["total_reads"] * 100, 2)
        if m.get("mapped_reads") and m.get("total_reads"):
            m["pct_mapped"] = round(m["mapped_reads"] / m["total_reads"] * 100, 2)
    except Exception as e:
        logger.debug(f"{sample_id}: mapping_metrics missing ({e})")

    try:
        text = s3.get_object(Bucket=SRC_BUCKET, Key=f"{base}.vc_metrics.csv")["Body"].read().decode("utf-8")
        for line in text.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 4:
                continue
            # Post-filter per-sample variant stats (not the PREFILTER/SUMMARY rows).
            if parts[0] != "VARIANT CALLER POSTFILTER":
                continue
            key, val = parts[2], parts[3]
            if key == "SNPs":
                try: m["snp_count"] = int(val)
                except ValueError: pass
            elif key in ("Insertions (Hom)", "Insertions (Het)"):
                try: m["ins_count"] = m.get("ins_count", 0) + int(val)
                except ValueError: pass
            elif key in ("Deletions (Hom)", "Deletions (Het)"):
                try: m["del_count"] = m.get("del_count", 0) + int(val)
                except ValueError: pass
            elif key == "Ti/Tv ratio":
                try: m["titv_ratio"] = float(val)
                except ValueError: pass
            elif key == "Heterozygous":
                try: m["het_count"] = int(val)
                except ValueError: pass
            elif key == "Homozygous":
                try: m["hom_count"] = int(val)
                except ValueError: pass
            elif key == "Total":
                try: m["total_variants"] = int(val)
                except ValueError: pass
        if m.get("het_count") and m.get("hom_count", 0) > 0:
            m["het_hom_ratio"] = round(m["het_count"] / m["hom_count"], 3)
    except Exception as e:
        logger.debug(f"{sample_id}: vc_metrics missing ({e})")

    return m


def main() -> None:
    logger.info("Loading 1000G 30x metadata…")
    meta = _load_metadata()
    sample_ids = sorted(meta.keys())
    n = len(sample_ids)
    logger.info(f"{n} samples in panel. Reading QC metrics ({MAX_WORKERS} workers)…")

    rows: dict[str, dict] = {}
    done = 0
    with_qc = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(_read_qc, sid): sid for sid in sample_ids}
        for fut in concurrent.futures.as_completed(futs):
            sid = futs[fut]
            qc = fut.result()
            if qc.get("mean_coverage") is not None:
                with_qc += 1
            rows[sid] = {**meta[sid], **qc, "sample_id": sid}
            done += 1
            if done % 200 == 0 or done == n:
                logger.info(f"  {done}/{n} samples ({with_qc} with coverage)")

    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for sid in sample_ids:
            r = rows[sid]
            w.writerow(["" if r.get(c) is None else r.get(c) for c in COLUMNS])

    logger.info(f"Wrote {n} rows to {OUT} ({with_qc} with QC metrics).")
    logger.info("Next: PUT + COPY INTO GRAGEN_DB.GRAGEN.SAMPLE_METRICS (see README / SKILL).")


if __name__ == "__main__":
    main()
