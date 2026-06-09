-- =============================================================================
-- GRAGEN Genomics Accelerator — Deploy SPCS Services  v1.0.1
-- =============================================================================
-- Run AFTER images are pushed to the registry.
-- Replace <REGISTRY> and <VERSION> with actual values, or use deploy.sh.
--
-- Backend env vars mirror the weather icechunk-service:
--   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY — for icechunk-ro S3 bucket
--   ICECHUNK_BUCKET    = icechunk-ro      (same bucket as weather project)
--   ICECHUNK_GENOMICS_PREFIX = genomics_repo  (different prefix)
--   INGEST_WORKERS     = 16               (parallel VCF readers during ingest)
--
-- Usage:
--   snow sql -f sql/03_deploy_services.sql -c <CONNECTION>
--   (or use deploy.sh which generates this automatically)
-- =============================================================================

USE ROLE SYSADMIN;
USE SCHEMA GRAGEN_DB.GRAGEN;

-- ── Backend: gragen-service (FastAPI, port 8080) ──────────────────────────────
CREATE OR REPLACE SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE
  IN COMPUTE POOL GRAGEN_COMPUTE_POOL
  FROM SPECIFICATION $$
spec:
  containers:
  - name: gragen-service
    image: /<REGISTRY>/gragen-service:<VERSION>
    env:
      PYTHONUNBUFFERED:           "1"
      ICECHUNK_BUCKET:            "icechunk-ro"
      ICECHUNK_GENOMICS_PREFIX:   "genomics_repo"
      AWS_DEFAULT_REGION:         "us-west-2"
      INGEST_WORKERS:             "16"
    secrets:
    - snowflakeSecret:
        objectName: ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID
      envVarName: AWS_ACCESS_KEY_ID
    - snowflakeSecret:
        objectName: ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY
      envVarName: AWS_SECRET_ACCESS_KEY
    readinessProbe:
      port: 8080
      path: /health
  endpoints:
  - name: api-endpoint
    port: 8080
    public: false
$$
EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI)
MIN_INSTANCES = 1
MAX_INSTANCES = 2;

-- ── Frontend: gragen-accelerator (React + Express, port 3001) ─────────────────
CREATE OR REPLACE SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE
  IN COMPUTE POOL GRAGEN_COMPUTE_POOL
  FROM SPECIFICATION $$
spec:
  containers:
  - name: gragen-accelerator
    image: /<REGISTRY>/gragen-accelerator:<VERSION>
    env:
      GRAGEN_SERVICE_URL:    "http://gragen-service:8080"
      SNOWFLAKE_DATABASE:    "GRAGEN_DB"
      SNOWFLAKE_SCHEMA:      "GRAGEN"
      SNOWFLAKE_WAREHOUSE:   "GRAGEN_WH"
    readinessProbe:
      port: 3001
      path: /healthz
  endpoints:
  - name: http-endpoint
    port: 3001
    public: true
$$
EXTERNAL_ACCESS_INTEGRATIONS = (GRAGEN_MAP_TILES_EAI)
MIN_INSTANCES = 1
MAX_INSTANCES = 1;

-- ── Show app URL ──────────────────────────────────────────────────────────────
SHOW ENDPOINTS IN SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE;

SELECT 'Services deployed. Next steps:
1. Seed chr22 into IceChunk (takes ~2-10 min depending on workers):
     POST https://<URL>/api/direct/seed_genomics
     body: {"chroms": ["chr22"]}
2. Check store has data:
     GET  https://<URL>/api/meta
3. Then try the genome browser:
     Open https://<URL>
     → Genome Browser → chr22:20000000-25000000
' AS next_steps;
