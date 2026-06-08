#!/usr/bin/env python3
"""
iceberg_seed.py — Materialize IceChunk Zarr data into Snowflake Iceberg tables.

Reads chr22 variants and ClinVar data from the IceChunk stores on S3
and bulk-inserts into Snowflake-managed Iceberg tables via Snowpark.

Run via EXECUTE JOB SERVICE or locally.
"""
import logging, os, sys, time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("iceberg_seed")

# ── IceChunk + Zarr imports ───────────────────────────────────────────────────

import numpy as np
import zarr
import icechunk
from icechunk.storage import s3_storage

BUCKET           = os.environ.get("ICECHUNK_BUCKET",          "icechunk-ro")
GENOMICS_PREFIX  = os.environ.get("ICECHUNK_GENOMICS_PREFIX", "genomics_repo")
CLINVAR_PREFIX   = os.environ.get("ICECHUNK_CLINVAR_PREFIX",  "clinvar_repo")
REGION           = os.environ.get("AWS_DEFAULT_REGION",       "us-west-2")
AWS_KEY          = os.environ.get("AWS_ACCESS_KEY_ID")
AWS_SECRET       = os.environ.get("AWS_SECRET_ACCESS_KEY")

CHROMOSOMES      = os.environ.get("SEED_CHROMS", "chr22").split(",")
BATCH_SIZE       = int(os.environ.get("BATCH_SIZE", "200000"))   # rows per INSERT batch

SNOWFLAKE_ACCOUNT = os.environ.get("SNOWFLAKE_ACCOUNT",    "SFSEHOL-INTERNAL_MARKETPLACE")
SNOWFLAKE_USER    = os.environ.get("SNOWFLAKE_USER",        "BOCONNOR_SERVICE")
SNOWFLAKE_ROLE    = os.environ.get("SNOWFLAKE_ROLE",        "ACCOUNTADMIN")
SNOWFLAKE_WH      = os.environ.get("SNOWFLAKE_WH",          "GRAGEN_WH")
SNOWFLAKE_DB      = os.environ.get("SNOWFLAKE_DB",          "GRAGEN_DB")
SNOWFLAKE_SCHEMA  = os.environ.get("SNOWFLAKE_SCHEMA",      "GRAGEN")


def _storage(prefix: str) -> icechunk.Storage:
    kwargs = dict(bucket=BUCKET, prefix=prefix, region=REGION)
    if AWS_KEY and AWS_SECRET:
        kwargs["access_key_id"]     = AWS_KEY
        kwargs["secret_access_key"] = AWS_SECRET
    else:
        kwargs["from_env"] = True
    return s3_storage(**kwargs)


def open_repo(prefix: str) -> zarr.Group:
    repo    = icechunk.Repository.open(storage=_storage(prefix))
    session = repo.readonly_session("main")
    return zarr.open_group(session.store, mode="r")


def materialize_variants(conn, chromosomes: list[str]):
    """Read genomics IceChunk store and INSERT into CHR22_VARIANTS Iceberg table."""
    logger.info("Opening genomics IceChunk repo…")
    root = open_repo(GENOMICS_PREFIX)

    cur = conn.cursor()
    total_rows = 0

    for chrom in chromosomes:
        if chrom not in root:
            logger.warning(f"{chrom} not in genomics store, skipping")
            continue

        grp = root[chrom]
        n   = len(grp["position"])
        logger.info(f"{chrom}: {n:,} variants → CHR22_VARIANTS")

        position     = np.array(grp["position"][:],     dtype=np.int32)
        allele_freq  = np.array(grp["allele_freq"][:],  dtype=np.float32)
        het_rate     = np.array(grp["het_rate"][:],     dtype=np.float32)
        variant_type = np.array(grp["variant_type"][:], dtype=np.int8)
        ref_len      = np.array(grp["ref_len"][:],      dtype=np.int16)

        # Truncate existing rows for this chrom before re-loading
        cur.execute(f"DELETE FROM GRAGEN_DB.GRAGEN.CHR22_VARIANTS WHERE chrom = %s", (chrom,))

        for start in range(0, n, BATCH_SIZE):
            end   = min(start + BATCH_SIZE, n)
            batch = [
                (chrom,
                 int(position[i]),
                 float(allele_freq[i]),
                 float(het_rate[i]),
                 int(variant_type[i]),
                 int(ref_len[i]))
                for i in range(start, end)
            ]
            cur.executemany(
                "INSERT INTO GRAGEN_DB.GRAGEN.CHR22_VARIANTS "
                "(chrom, position, allele_freq, het_rate, variant_type, ref_len) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                batch,
            )
            total_rows += len(batch)
            logger.info(f"  {chrom}: inserted {total_rows:,} rows so far")

    conn.commit()
    logger.info(f"Genomics: {total_rows:,} rows committed to CHR22_VARIANTS")
    cur.close()
    return total_rows


def materialize_clinvar(conn, chromosomes: list[str]):
    """Read ClinVar IceChunk store and INSERT into CHR22_CLINVAR Iceberg table."""
    logger.info("Opening ClinVar IceChunk repo…")
    root = open_repo(CLINVAR_PREFIX)

    cur = conn.cursor()
    total_rows = 0

    for chrom in chromosomes:
        if chrom not in root:
            logger.warning(f"{chrom} not in ClinVar store, skipping")
            continue

        grp = root[chrom]
        n   = len(grp["position"])
        logger.info(f"{chrom}: {n:,} ClinVar variants → CHR22_CLINVAR")

        position  = np.array(grp["position"][:],  dtype=np.int32)
        clinsig   = np.array(grp["clinsig"][:],   dtype=np.int8)
        revstat   = np.array(grp["revstat"][:],   dtype=np.int8)
        allele_id = np.array(grp["allele_id"][:], dtype=np.int32)
        ref_len   = np.array(grp["ref_len"][:],   dtype=np.int8)
        alt_len   = np.array(grp["alt_len"][:],   dtype=np.int8)

        cur.execute(f"DELETE FROM GRAGEN_DB.GRAGEN.CHR22_CLINVAR WHERE chrom = %s", (chrom,))

        for start in range(0, n, BATCH_SIZE):
            end   = min(start + BATCH_SIZE, n)
            batch = [
                (chrom,
                 int(position[i]),
                 int(clinsig[i]),
                 int(revstat[i]),
                 int(allele_id[i]),
                 int(ref_len[i]),
                 int(alt_len[i]))
                for i in range(start, end)
            ]
            cur.executemany(
                "INSERT INTO GRAGEN_DB.GRAGEN.CHR22_CLINVAR "
                "(chrom, position, clinsig, revstat, allele_id, ref_len, alt_len) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                batch,
            )
            total_rows += len(batch)
            logger.info(f"  {chrom}: {total_rows:,} ClinVar rows inserted")

    conn.commit()
    logger.info(f"ClinVar: {total_rows:,} rows committed to CHR22_CLINVAR")
    cur.close()
    return total_rows


def main():
    import snowflake.connector
    t0 = time.time()

    logger.info(f"=== Iceberg seed: chroms={CHROMOSOMES}, batch={BATCH_SIZE:,} ===")

    # Prefer SPCS OAuth token (available inside container at /snowflake/session/token)
    spcs_token_path = "/snowflake/session/token"
    if os.path.exists(spcs_token_path):
        with open(spcs_token_path) as f:
            sf_token = f.read().strip()
        conn_kwargs = dict(
            account        = SNOWFLAKE_ACCOUNT,
            authenticator  = "oauth",
            token          = sf_token,
            role           = SNOWFLAKE_ROLE,
            warehouse      = SNOWFLAKE_WH,
            database       = SNOWFLAKE_DB,
            schema         = SNOWFLAKE_SCHEMA,
        )
        logger.info("Using SPCS OAuth token for Snowflake auth")
    else:
        # Local dev: use named connection from ~/.snowflake/connections.toml
        conn_kwargs = dict(
            connection_name = os.environ.get("SNOWFLAKE_CONNECTION", "internal-marketplace"),
            warehouse       = SNOWFLAKE_WH,
            database        = SNOWFLAKE_DB,
            schema          = SNOWFLAKE_SCHEMA,
        )
        logger.info("Using named Snowflake connection (local dev)")

    logger.info("Connecting to Snowflake…")
    conn = snowflake.connector.connect(**conn_kwargs)
    logger.info("Connected.")

    seed_type = os.environ.get("SEED_TYPE", "all").lower()

    if seed_type in ("all", "genomics"):
        g_rows = materialize_variants(conn, CHROMOSOMES)
        logger.info(f"Genomics done: {g_rows:,} rows in {time.time()-t0:.0f}s")

    if seed_type in ("all", "clinvar"):
        c_rows = materialize_clinvar(conn, CHROMOSOMES)
        logger.info(f"ClinVar done: {c_rows:,} rows in {time.time()-t0:.0f}s")

    conn.close()
    logger.info(f"=== Iceberg seed complete in {time.time()-t0:.0f}s ===")


if __name__ == "__main__":
    main()
