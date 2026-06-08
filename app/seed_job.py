#!/usr/bin/env python3
"""
seed_job.py — Standalone entrypoint for EXECUTE JOB SERVICE.

Runs VCF → IceChunk ingest or IceChunk → Iceberg materialization.
Configured via environment variables:
  SEED_TYPE        "genomics" | "clinvar" | "iceberg_all" | "iceberg" | "iceberg_clinvar"
  SEED_CHROMS      comma-separated chromosomes (default: chr22)
  INGEST_WORKERS   parallel download threads   (default: 8, genomics/clinvar only)
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
        from ingest_clinvar import ingest_clinvar
        result = ingest_clinvar(chroms=chroms)

    elif seed_type in ("iceberg", "iceberg_genomics"):
        # Materialize IceChunk genomics Zarr → Snowflake Iceberg table
        from iceberg_seed import materialize_variants
        import snowflake.connector
        conn = snowflake.connector.connect(
            connection_name=os.environ.get("SNOWFLAKE_CONNECTION", "internal-marketplace")
        )
        result = {"genomics_rows": materialize_variants(conn, chroms)}
        conn.close()

    elif seed_type == "iceberg_clinvar":
        from iceberg_seed import materialize_clinvar
        import snowflake.connector
        conn = snowflake.connector.connect(
            connection_name=os.environ.get("SNOWFLAKE_CONNECTION", "internal-marketplace")
        )
        result = {"clinvar_rows": materialize_clinvar(conn, chroms)}
        conn.close()

    elif seed_type == "iceberg_all":
        # Materialize both stores into Iceberg tables
        from iceberg_seed import materialize_variants, materialize_clinvar
        import snowflake.connector
        conn = snowflake.connector.connect(
            connection_name=os.environ.get("SNOWFLAKE_CONNECTION", "internal-marketplace")
        )
        g = materialize_variants(conn, chroms)
        c = materialize_clinvar(conn, chroms)
        conn.close()
        result = {"genomics_rows": g, "clinvar_rows": c}

    else:  # default: genomics VCF ingest
        from ingest_genomics import ingest_genomics
        result = ingest_genomics(chroms=chroms, max_workers=workers)

    logger.info(f"=== Seed complete: {json.dumps(result, default=str)} ===")
    sys.exit(0)
except Exception:
    logger.exception("=== Seed FAILED ===")
    sys.exit(1)
