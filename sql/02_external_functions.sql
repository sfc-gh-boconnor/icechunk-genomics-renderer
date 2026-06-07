-- =============================================================================
-- GRAGEN Genomics Accelerator — External Functions + Cortex Agent  v1.0.1
-- =============================================================================
-- Run AFTER deploying SPCS services (the API integration needs the endpoint URL).
--
-- Usage:
--   snow sql -f sql/02_external_functions.sql -c <CONNECTION>
-- =============================================================================

USE ROLE SYSADMIN;
USE SCHEMA GRAGEN_DB.GRAGEN;
USE WAREHOUSE GRAGEN_WH;

-- ── API Integration for external function ─────────────────────────────────────
-- Replace <GRAGEN_SERVICE_ENDPOINT> with the URL from:
--   SHOW ENDPOINTS IN SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE;
-- It will look like: https://abc123-account.snowflakecomputing.app

CREATE OR REPLACE API INTEGRATION GRAGEN_API_INTEGRATION
  API_PROVIDER = aws_private_api_gateway  -- not actually AWS; Snowflake manages this
  API_AWS_ROLE_ARN = ''
  ENABLED = TRUE
  API_ALLOWED_PREFIXES = ('<GRAGEN_SERVICE_ENDPOINT>');

-- Note: For SPCS-hosted functions, the integration type is actually:
-- API_PROVIDER = snowflake_service_integration
-- The exact syntax depends on your Snowflake version. Adjust if needed.

-- ── GRAGEN_SLICE external function ───────────────────────────────────────────
-- Queries variants in a genomic region for a given sample.
-- Input:  (sample_id VARCHAR, chrom VARCHAR, start_pos INTEGER, end_pos INTEGER)
-- Output: VARIANT containing { variants: [...], count: int, density: [...] }
CREATE OR REPLACE FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_SLICE(
  SAMPLE_ID  VARCHAR,
  CHROM      VARCHAR,
  START_POS  INTEGER,
  END_POS    INTEGER
)
RETURNS VARIANT
API_INTEGRATION = GRAGEN_API_INTEGRATION
AS '<GRAGEN_SERVICE_ENDPOINT>/slice';

-- ── Cortex Agent ─────────────────────────────────────────────────────────────
-- Tool stored procedures called by the GENOMICS_AGENT

-- Tool 1: Cohort summary query
CREATE OR REPLACE PROCEDURE GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY(
  QUESTION VARCHAR
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
def run(session, question: str) -> dict:
    try:
        # Get top-level cohort stats
        summary = session.sql("""
            SELECT
                superpopulation,
                COUNT(*)                           AS sample_count,
                ROUND(AVG(mean_coverage), 1)       AS avg_coverage,
                ROUND(AVG(pct_duplicates), 2)      AS avg_dup_pct,
                ROUND(AVG(titv_ratio), 3)          AS avg_titv,
                ROUND(AVG(total_variants), 0)      AS avg_variants,
                ROUND(AVG(het_hom_ratio), 3)       AS avg_het_hom
            FROM GRAGEN_DB.GRAGEN.SAMPLE_METRICS
            WHERE mean_coverage IS NOT NULL
            GROUP BY superpopulation
            ORDER BY superpopulation
        """).collect()
        return {
            'cohort_stats': [dict(row) for row in summary],
            'status': 'SUCCESS'
        }
    except Exception as e:
        return {'error': str(e), 'status': 'FAILED'}
$$;

-- Tool 2: Sample metadata lookup
CREATE OR REPLACE PROCEDURE GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META(
  SAMPLE_ID VARCHAR
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
def run(session, sample_id: str) -> dict:
    try:
        rows = session.sql(f"""
            SELECT * FROM GRAGEN_DB.GRAGEN.SAMPLE_METRICS
            WHERE sample_id = '{sample_id.replace("'","''")}' LIMIT 1
        """).collect()
        if not rows:
            return {'error': f'Sample {sample_id} not found', 'status': 'FAILED'}
        return {'sample': dict(rows[0]), 'status': 'SUCCESS'}
    except Exception as e:
        return {'error': str(e), 'status': 'FAILED'}
$$;

-- Tool 3: Outlier detection
CREATE OR REPLACE PROCEDURE GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS(
  METRIC  VARCHAR,
  N_TOP   INTEGER
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
def run(session, metric: str, n_top: int = 10) -> dict:
    allowed = {'mean_coverage','pct_duplicates','titv_ratio','total_variants','het_hom_ratio'}
    if metric not in allowed:
        return {'error': f'Metric must be one of {sorted(allowed)}', 'status': 'FAILED'}
    try:
        rows = session.sql(f"""
            SELECT sample_id, population, superpopulation, {metric}
            FROM GRAGEN_DB.GRAGEN.SAMPLE_METRICS
            WHERE {metric} IS NOT NULL
            ORDER BY {metric} DESC
            LIMIT {int(n_top)}
        """).collect()
        return {'outliers': [dict(r) for r in rows], 'metric': metric, 'status': 'SUCCESS'}
    except Exception as e:
        return {'error': str(e), 'status': 'FAILED'}
$$;

-- ── Create the Cortex Agent ───────────────────────────────────────────────────
CREATE OR REPLACE AGENT GRAGEN_DB.GRAGEN.GENOMICS_AGENT
COMMENT = 'Genomics analysis agent for the 1000 Genomes DRAGEN re-analysis dataset (3,202 samples, hg38 graph-based).'
PROFILE = '{"display_name": "Genomics Agent", "color": "green"}'
FROM SPECIFICATION $$
models:
  orchestration: auto
orchestration:
  budget:
    seconds: 120
    tokens: 32000
instructions:
  system: |
    You are a genomics data analyst for the 1000 Genomes Project DRAGEN re-analysis dataset.
    
    Dataset: 3,202 samples re-processed with Illumina DRAGEN 3.7.6 against the hg38 graph-based reference.
    Superpopulations: AFR (African), AMR (Admixed American), EAS (East Asian), EUR (European), SAS (South Asian).
    
    QC metrics available:
    - mean_coverage: average depth of coverage (typically 25-35×)
    - pct_duplicates: % of reads marked as duplicates (typically 5-15%)
    - titv_ratio: transition/transversion ratio (typically 1.9-2.1 for WGS)
    - total_variants: total called variants per sample (~4-6 million for WGS)
    - het_hom_ratio: heterozygous/homozygous variant ratio
    
    CRITICAL RULES:
    1. ALWAYS call a tool for data questions. Never invent statistics.
    2. Use tool_cohort_query for population-level comparisons.
    3. Use tool_sample_meta for questions about a specific sample ID.
    4. Use tool_find_outliers for "which samples have highest/lowest X" questions.
    5. Report population differences objectively — differences in Ti/Tv or variant counts reflect population history and ascertainment, not quality.

  response: |
    Be concise. Always show:
    - Actual numbers from the data
    - Population context (AFR/AMR/EAS/EUR/SAS)
    - Brief biological interpretation where relevant
    Format as a short paragraph followed by a table if comparing populations.

tools:
  - tool_spec:
      type: generic
      name: tool_cohort_query
      description: "Get QC statistics grouped by superpopulation (AFR/AMR/EAS/EUR/SAS): sample counts, coverage, duplicate rate, Ti/Tv ratio, variant counts."
      input_schema:
        type: object
        properties:
          question:
            type: string
            description: "Natural language question about the cohort"
        required: [question]
  - tool_spec:
      type: generic
      name: tool_sample_meta
      description: "Get QC metrics for a specific sample ID (e.g. HG00096, NA20502)."
      input_schema:
        type: object
        properties:
          sample_id:
            type: string
            description: "1000 Genomes sample ID (e.g. HG00096)"
        required: [sample_id]
  - tool_spec:
      type: generic
      name: tool_find_outliers
      description: "Find samples with the highest or lowest value of a QC metric."
      input_schema:
        type: object
        properties:
          metric:
            type: string
            description: "Metric name: mean_coverage, pct_duplicates, titv_ratio, total_variants, het_hom_ratio"
          n_top:
            type: integer
            description: "Number of top samples to return (default 10)"
        required: [metric]

tool_resources:
  tool_cohort_query:
    type: procedure
    identifier: GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY
    execution_environment:
      type: warehouse
      warehouse: GRAGEN_WH
  tool_sample_meta:
    type: procedure
    identifier: GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META
    execution_environment:
      type: warehouse
      warehouse: GRAGEN_WH
  tool_find_outliers:
    type: procedure
    identifier: GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS
    execution_environment:
      type: warehouse
      warehouse: GRAGEN_WH
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY(VARCHAR)       TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META(VARCHAR)        TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS(VARCHAR, INTEGER) TO ROLE SYSADMIN;
GRANT USAGE ON AGENT     GRAGEN_DB.GRAGEN.GENOMICS_AGENT                   TO ROLE SYSADMIN;

-- Grant to the service identity role (replace GRAGEN_DB with your role name)
GRANT USAGE ON AGENT     GRAGEN_DB.GRAGEN.GENOMICS_AGENT                   TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY(VARCHAR)       TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META(VARCHAR)        TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS(VARCHAR, INTEGER) TO ROLE GRAGEN_DB;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE GRAGEN_DB;

SELECT 'External functions and Cortex Agent created successfully.' AS status;

-- =============================================================================
-- CLINVAR_SLICE external function
-- =============================================================================
-- Queries ClinVar clinical variants in a genomic region.
-- Input:  CLINVAR_SLICE(chrom VARCHAR, start_pos INTEGER, end_pos INTEGER)
-- Output: VARIANT containing { variants: [{pos, clinsig, clinsig_label, ...}] }
CREATE OR REPLACE FUNCTION GRAGEN_DB.GRAGEN.CLINVAR_SLICE(
  CHROM     VARCHAR,
  START_POS INTEGER,
  END_POS   INTEGER
)
RETURNS VARIANT
API_INTEGRATION = GRAGEN_API_INTEGRATION
AS '<GRAGEN_SERVICE_ENDPOINT>/slice_clinvar';

GRANT USAGE ON FUNCTION GRAGEN_DB.GRAGEN.CLINVAR_SLICE(VARCHAR, INTEGER, INTEGER)
  TO ROLE GRAGEN_DB;
GRANT USAGE ON FUNCTION GRAGEN_DB.GRAGEN.CLINVAR_SLICE(VARCHAR, INTEGER, INTEGER)
  TO ROLE SYSADMIN;

SELECT 'ClinVar external function created. Run seed_clinvar to populate the store.' AS status;
