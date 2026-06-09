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


def _restart_backend_service():
    """Best-effort: restart the backend so it re-opens the IceChunk store and
    serves the newly-ingested chromosome. The cached repo handle in the running
    backend does NOT see commits made by this out-of-container job, so a
    SUSPEND/RESUME is required. Controlled by the RESTART_SERVICE env var
    (set by the SEED_CHROMOSOME stored proc)."""
    svc = os.environ.get("RESTART_SERVICE")
    if not svc:
        return
    try:
        import snowflake.connector
        token_path = "/snowflake/session/token"
        if not os.path.exists(token_path):
            logger.warning("[restart] No SPCS token; skipping backend restart.")
            return
        with open(token_path) as f:
            token = f.read().strip()
        kwargs = dict(
            account       = os.environ.get("SNOWFLAKE_ACCOUNT"),
            authenticator = "oauth",
            token         = token,
            database      = os.environ.get("SNOWFLAKE_DB", "GRAGEN_DB"),
            schema        = os.environ.get("SNOWFLAKE_SCHEMA", "GRAGEN"),
        )
        host = os.environ.get("SNOWFLAKE_HOST")
        if host:
            kwargs["host"] = host
        role = os.environ.get("SNOWFLAKE_ROLE")
        if role:
            kwargs["role"] = role
        logger.info(f"[restart] Restarting backend service {svc}…")
        conn = snowflake.connector.connect(**kwargs)
        try:
            cur = conn.cursor()
            cur.execute(f"ALTER SERVICE {svc} SUSPEND")
            cur.execute(f"ALTER SERVICE {svc} RESUME")
            logger.info(f"[restart] {svc} suspended + resumed.")
        finally:
            conn.close()
    except Exception:
        logger.exception("[restart] Backend restart failed (non-fatal). "
                          "Restart it manually: ALTER SERVICE … SUSPEND; RESUME.")


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

    # Genomics ingest changed the Zarr store the backend serves → restart it so
    # the cached repo handle re-opens at the new snapshot (no-op if unset).
    if seed_type in ("genomics", "clinvar") or seed_type not in (
            "iceberg", "iceberg_genomics", "iceberg_clinvar", "iceberg_all"):
        _restart_backend_service()

    sys.exit(0)
except Exception:
    logger.exception("=== Seed FAILED ===")
    sys.exit(1)
