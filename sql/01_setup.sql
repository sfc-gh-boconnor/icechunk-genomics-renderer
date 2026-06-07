-- =============================================================================
-- GRAGEN Genomics Accelerator — Snowflake Setup  v1.0.1
-- =============================================================================
-- Run as SYSADMIN / ACCOUNTADMIN.
-- NOTE: Reuses the existing icechunk-ro S3 bucket and AWS secrets from the
--       weather (IceChunk) project. No new S3 bucket or IAM user needed.
--       The genomics IceChunk store is written to prefix "genomics_repo/"
--       in the same bucket.
--
-- Usage:
--   snow sql -f sql/01_setup.sql -c <CONNECTION>
--
-- Prerequisites (already exist from weather project):
--   - S3 bucket: icechunk-ro
--   - Snowflake secrets: ICECHUNK_AWS_KEY_ID, ICECHUNK_AWS_SECRET_KEY
--   - EAI: ICECHUNK_S3_EAI (for private S3 read/write)
-- =============================================================================

USE ROLE SYSADMIN;

-- ── Database + schema ─────────────────────────────────────────────────────────
CREATE DATABASE IF NOT EXISTS GRAGEN_DB;
CREATE SCHEMA  IF NOT EXISTS GRAGEN_DB.GRAGEN;
USE SCHEMA GRAGEN_DB.GRAGEN;

-- ── Warehouse ─────────────────────────────────────────────────────────────────
CREATE WAREHOUSE IF NOT EXISTS GRAGEN_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 60
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

-- ── Image repository ──────────────────────────────────────────────────────────
CREATE IMAGE REPOSITORY IF NOT EXISTS GRAGEN_DB.GRAGEN.GRAGEN_REPO;

-- ── Compute pool ──────────────────────────────────────────────────────────────
CREATE COMPUTE POOL IF NOT EXISTS GRAGEN_COMPUTE_POOL
  MIN_NODES = 1
  MAX_NODES = 2
  INSTANCE_FAMILY = CPU_X64_S
  AUTO_RESUME = TRUE
  AUTO_SUSPEND_SECS = 300
  COMMENT = 'GRAGEN Genomics Accelerator compute pool';

-- ── External Access Integrations ──────────────────────────────────────────────
USE ROLE ACCOUNTADMIN;

-- EAI 1: Private S3 bucket (icechunk-ro) — for reading/writing the IceChunk
--         genomics Zarr store. REUSES the same bucket as the weather project.
--         If ICECHUNK_S3_EAI already exists, skip this block.
CREATE OR REPLACE NETWORK RULE ICECHUNK_S3_NETWORK_RULE
  TYPE = HOST_PORT
  MODE = EGRESS
  VALUE_LIST = (
    's3.amazonaws.com',
    's3.us-west-2.amazonaws.com',
    'icechunk-ro.s3.amazonaws.com',
    'icechunk-ro.s3.us-west-2.amazonaws.com'
  );

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ICECHUNK_S3_EAI
  ALLOWED_NETWORK_RULES = (ICECHUNK_S3_NETWORK_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (ICECHUNK_DB.ICECHUNK.ICECHUNK_AWS_KEY_ID,
                                    ICECHUNK_DB.ICECHUNK.ICECHUNK_AWS_SECRET_KEY)
  ENABLED = TRUE
  COMMENT = 'Private S3 access for IceChunk store (shared with weather project)';

-- EAI 2: Public 1000 Genomes S3 bucket — for ingesting VCF files and reading
--         sample metadata. Public bucket: no credentials needed, but SPCS still
--         requires an EAI for any outbound HTTPS call.
CREATE OR REPLACE NETWORK RULE GENOMICS_1000G_NETWORK_RULE
  TYPE = HOST_PORT
  MODE = EGRESS
  VALUE_LIST = (
    '1000genomes-dragen.s3.amazonaws.com',
    '1000genomes-dragen.s3.us-east-1.amazonaws.com',
    's3.us-east-1.amazonaws.com'
  );

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION GENOMICS_1000G_EAI
  ALLOWED_NETWORK_RULES = (GENOMICS_1000G_NETWORK_RULE)
  ENABLED = TRUE
  COMMENT = 'Public 1000 Genomes DRAGEN S3 bucket (no auth required)';

-- EAI 3: CARTO map tiles (for the genome browser base map)
CREATE OR REPLACE NETWORK RULE CARTO_TILES_NETWORK_RULE
  TYPE = HOST_PORT
  MODE = EGRESS
  VALUE_LIST = ('a.basemaps.cartocdn.com', 'b.basemaps.cartocdn.com',
                'c.basemaps.cartocdn.com', 'd.basemaps.cartocdn.com');

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION GRAGEN_MAP_TILES_EAI
  ALLOWED_NETWORK_RULES = (CARTO_TILES_NETWORK_RULE)
  ENABLED = TRUE;

USE ROLE SYSADMIN;

-- ── AWS credentials (reuse from weather project) ──────────────────────────────
-- The gragen-service container needs the same AWS credentials that the
-- icechunk-service uses to write to the icechunk-ro bucket.
-- If ICECHUNK_AWS_KEY_ID / ICECHUNK_AWS_SECRET_KEY already exist in
-- ICECHUNK_DB.ICECHUNK, grant access to GRAGEN_DB role instead of creating new.
--
-- If this is a fresh account, create new secrets:
-- CREATE SECRET GRAGEN_DB.GRAGEN.AWS_KEY_ID
--   TYPE = GENERIC_STRING
--   SECRET_STRING = '<your-aws-access-key-id>';
-- CREATE SECRET GRAGEN_DB.GRAGEN.AWS_SECRET_KEY
--   TYPE = GENERIC_STRING
--   SECRET_STRING = '<your-aws-secret-access-key>';

-- ── Sample QC metrics table ────────────────────────────────────────────────────
-- Populated by the /seed_genomics endpoint reading CSV files from S3.
-- Equivalent to having weather data pre-loaded for the cohort scatter view.
CREATE TABLE IF NOT EXISTS GRAGEN_DB.GRAGEN.SAMPLE_METRICS (
  sample_id         VARCHAR(20)    NOT NULL,
  population        VARCHAR(10),
  superpopulation   VARCHAR(5),
  sex               VARCHAR(10),
  mean_coverage     FLOAT,
  pct_duplicates    FLOAT,
  pct_mapped        FLOAT,
  total_reads       BIGINT,
  mapped_reads      BIGINT,
  dup_reads         BIGINT,
  total_variants    INTEGER,
  snp_count         INTEGER,
  ins_count         INTEGER,
  del_count         INTEGER,
  titv_ratio        FLOAT,
  het_count         INTEGER,
  hom_count         INTEGER,
  het_hom_ratio     FLOAT,
  loaded_at         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (sample_id)
);

SELECT 'Setup complete. Next steps:
1. Build and push Docker images:
   bash deploy.sh --build-only
2. Deploy SPCS services:
   bash deploy.sh
3. Trigger genomics ingest (chr22 first):
   curl -X POST https://<URL>/api/direct/seed_genomics
     -H "Content-Type: application/json"
     -d "{\"chroms\": [\"chr22\"]}"
4. Create external functions + agent:
   snow sql -f sql/02_external_functions.sql -c <CONNECTION>
' AS instructions;
