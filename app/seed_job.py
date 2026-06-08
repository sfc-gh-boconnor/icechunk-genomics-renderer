#!/usr/bin/env python3
"""
seed_job.py — Standalone entrypoint for EXECUTE JOB SERVICE.

Runs VCF → IceChunk ingest directly (no FastAPI, no uvicorn).
Configured via environment variables:
  SEED_TYPE        "genomics" or "clinvar" (default: genomics)
  SEED_CHROMS      comma-separated chromosomes (default: chr22)
  INGEST_WORKERS   parallel download threads   (default: 8, genomics only)
"""
import json
import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s:%(name)s: %(message)s",
    stream=sys.stdout,
)
logging.getLogger("ingest_genomics").setLevel(logging.DEBUG)
logging.getLogger("ingest_clinvar").setLevel(logging.DEBUG)
logger = logging.getLogger("seed_job")

seed_type = os.environ.get("SEED_TYPE", "genomics").lower()
chroms    = os.environ.get("SEED_CHROMS", "chr22").split(",")
workers   = int(os.environ.get("INGEST_WORKERS", "8"))

logger.info(f"=== GRAGEN Seed Job: type={seed_type}, chroms={chroms}, workers={workers} ===")

try:
    if seed_type == "clinvar":
        from ingest_clinvar import ingest_clinvar   # noqa: E402
        result = ingest_clinvar(chroms=chroms)
    else:
        from ingest_genomics import ingest_genomics  # noqa: E402
        result = ingest_genomics(chroms=chroms, max_workers=workers)

    logger.info(f"=== Seed complete: {json.dumps(result, default=str)} ===")
    sys.exit(0)
except Exception:
    logger.exception("=== Seed FAILED ===")
    sys.exit(1)
