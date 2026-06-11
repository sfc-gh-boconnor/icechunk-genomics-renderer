-- =============================================================================
-- GRAGEN — Annotation Iceberg tables (ClinVar + GWAS)
-- =============================================================================
-- Creates the two annotation tables whose DDL was previously only inline in
-- the skill doc. SFARI (AUTISM_GENES) and SAMPLE_PEDIGREE have their own
-- build_*.sql loaders. All BASE_LOCATIONs are RELATIVE — the deploy prefix
-- lives on GENOMICS_ICEBERG_VOLUME's STORAGE_BASE_URL, so these need no edits.
--
-- Prerequisite: setup.sh has run (GENOMICS_ICEBERG_VOLUME exists + IAM trust set).
-- Usage:
--   snow sql -c <CONNECTION> --warehouse GRAGEN_WH -f sql/04_annotation_tables.sql
-- Then load rows (see README "Load annotation tables"):
--   python3 app/build_clinvar_iceberg.py  &&  PUT + COPY INTO CHR22_CLINVAR
--   python3 app/build_gwas_iceberg.py     &&  PUT + COPY INTO CHR22_GWAS
-- =============================================================================

-- Runs as the connection's role (must be ACCOUNTADMIN; no USE ROLE so this works
-- in PAT-restricted sessions too).
USE SCHEMA GRAGEN_DB.GRAGEN;

-- ClinVar (genome-wide; ~4.4M rows). CLINSIG encoding matches frontend
-- CLINSIG_COLORS: 0=Benign 1=Likely benign 2=VUS 3=Likely pathogenic
-- 4=Pathogenic 5=Conflicting 6=Other.
CREATE ICEBERG TABLE IF NOT EXISTS GRAGEN_DB.GRAGEN.CHR22_CLINVAR (
  CHROM STRING, POSITION INT, CLINSIG INT, REVSTAT INT, ALLELE_ID INT,
  REF_LEN INT, ALT_LEN INT, DISEASE STRING, GENE STRING)
  EXTERNAL_VOLUME='GENOMICS_ICEBERG_VOLUME' ICEBERG_VERSION=2 CATALOG='SNOWFLAKE'
  BASE_LOCATION='chr22_clinvar/';

-- GWAS Catalog hits (genome-wide; ~10-15K rows).
CREATE ICEBERG TABLE IF NOT EXISTS GRAGEN_DB.GRAGEN.CHR22_GWAS (
  CHROM STRING, POSITION INT, TRAIT STRING, MAPPED_GENE STRING,
  RSID STRING, RISK_ALLELE STRING, P_VALUE FLOAT)
  EXTERNAL_VOLUME='GENOMICS_ICEBERG_VOLUME' ICEBERG_VERSION=2 CATALOG='SNOWFLAKE'
  BASE_LOCATION='chr22_gwas/';

-- Make annotations queryable by the frontend /api/query role + the app role.
GRANT SELECT ON GRAGEN_DB.GRAGEN.CHR22_CLINVAR TO ROLE PUBLIC;
GRANT SELECT ON GRAGEN_DB.GRAGEN.CHR22_GWAS    TO ROLE PUBLIC;
GRANT SELECT ON GRAGEN_DB.GRAGEN.CHR22_CLINVAR TO ROLE GRAGEN_DB;
GRANT SELECT ON GRAGEN_DB.GRAGEN.CHR22_GWAS    TO ROLE GRAGEN_DB;

SELECT 'CHR22_CLINVAR + CHR22_GWAS created. Load rows via build_*_iceberg.py + COPY INTO.' AS status;
