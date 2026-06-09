-- =============================================================================
-- GRAGEN Genomics Accelerator — External Functions + Cortex Agent  v1.0.1
-- =============================================================================
-- Run AFTER deploying SPCS services (the API integration needs the endpoint URL).
--
-- Usage:
--   snow sql -f sql/02_external_functions.sql -c <CONNECTION>
-- =============================================================================

-- Runs as the connection's role (must be ACCOUNTADMIN; no USE ROLE so this works
-- in PAT-restricted sessions too).
USE SCHEMA GRAGEN_DB.GRAGEN;
USE WAREHOUSE GRAGEN_WH;

-- App service-identity role (grants below target it). setup.sh creates role
-- GRAGEN_DB; GRAGEN_DB_ROLE is the legacy/app role name — ensure it exists so
-- the grants succeed on a fresh account too.
CREATE ROLE IF NOT EXISTS GRAGEN_DB_ROLE;

-- ── SPCS service functions: GRAGEN_SLICE / GRAGEN_CLINVAR_SLICE ──────────────
-- The genome browser fetches variants via these SQL functions (server/index.ts
-- calls GRAGEN_SLICE(chrom,start,end) and GRAGEN_CLINVAR_SLICE(chrom,start,end)).
-- They are SPCS *service functions* bound to GRAGEN_SERVICE's api-endpoint — NOT
-- API-integration external functions. The backend handlers are POST /slice and
-- POST /slice_clinvar. Run AFTER the backend service exists (deploy.sh).
CREATE OR REPLACE FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_SLICE(CHROM VARCHAR, START_POS INTEGER, END_POS INTEGER)
  RETURNS VARIANT
  SERVICE = GRAGEN_DB.GRAGEN.GRAGEN_SERVICE
  ENDPOINT = 'api-endpoint'
  AS '/slice';

CREATE OR REPLACE FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_CLINVAR_SLICE(CHROM VARCHAR, START_POS INTEGER, END_POS INTEGER)
  RETURNS VARIANT
  SERVICE = GRAGEN_DB.GRAGEN.GRAGEN_SERVICE
  ENDPOINT = 'api-endpoint'
  AS '/slice_clinvar';

GRANT USAGE ON FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_SLICE(VARCHAR,INTEGER,INTEGER) TO ROLE PUBLIC;
GRANT USAGE ON FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_CLINVAR_SLICE(VARCHAR,INTEGER,INTEGER) TO ROLE PUBLIC;
GRANT USAGE ON FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_SLICE(VARCHAR,INTEGER,INTEGER) TO ROLE GRAGEN_DB;
GRANT USAGE ON FUNCTION GRAGEN_DB.GRAGEN.GRAGEN_CLINVAR_SLICE(VARCHAR,INTEGER,INTEGER) TO ROLE GRAGEN_DB;

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
            'cohort_stats': [row.as_dict() for row in summary],
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
        return {'sample': rows[0].as_dict(), 'status': 'SUCCESS'}
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
        return {'outliers': [r.as_dict() for r in rows], 'metric': metric, 'status': 'SUCCESS'}
    except Exception as e:
        return {'error': str(e), 'status': 'FAILED'}
$$;

-- Tool 4: Genome annotation query (ClinVar / GWAS / SFARI Iceberg tables)
-- Supports three modes: by region, by gene, and summary counts.
CREATE OR REPLACE PROCEDURE GRAGEN_DB.GRAGEN.TOOL_QUERY_ANNOTATIONS(
  SOURCE     VARCHAR DEFAULT 'clinvar',
  CHROM      VARCHAR DEFAULT NULL,
  START_POS  INTEGER DEFAULT NULL,
  END_POS    INTEGER DEFAULT NULL,
  GENE       VARCHAR DEFAULT NULL,
  SUMMARY    BOOLEAN DEFAULT FALSE
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
CLINSIG = {0:'Benign',1:'Likely benign',2:'VUS',3:'Likely pathogenic',4:'Pathogenic',5:'Conflicting',6:'Other'}

def _q(session, sql):
    return [r.as_dict() for r in session.sql(sql).collect()]

def run(session, source='clinvar', chrom=None, start_pos=None, end_pos=None, gene=None, summary=False):
    try:
        source = (source or 'clinvar').lower().strip()
        if source not in ('clinvar','gwas','sfari','all'):
            return {'error': "source must be clinvar, gwas, sfari, or all", 'status':'FAILED'}

        def esc(s): return str(s).replace("'", "''")

        # ── Gene mode: resolve the gene to a region, then query that region ──
        if gene:
            g = esc(gene.upper())
            row = _q(session, f"""SELECT CHROM, START_POS, END_POS
                                    FROM GRAGEN_DB.GRAGEN.AUTISM_GENES
                                   WHERE UPPER(GENE)='{g}' LIMIT 1""")
            if not row:
                row = _q(session, f"""SELECT CHROM, MIN(POSITION) AS START_POS, MAX(POSITION) AS END_POS
                                        FROM GRAGEN_DB.GRAGEN.CHR22_CLINVAR
                                       WHERE UPPER(GENE)='{g}' GROUP BY CHROM
                                       ORDER BY COUNT(*) DESC LIMIT 1""")
            if not row:
                return {'error': f'Gene {gene} not found in SFARI or ClinVar annotations', 'status':'FAILED'}
            chrom     = row[0]['CHROM']
            start_pos = int(row[0]['START_POS'])
            end_pos   = int(row[0]['END_POS'])

        # Build an optional region predicate
        where = []
        if chrom:     where.append(f"CHROM='{esc(chrom)}'")
        if start_pos is not None and end_pos is not None:
            where.append(f"POSITION BETWEEN {int(start_pos)} AND {int(end_pos)}")
        wc = (" WHERE " + " AND ".join(where)) if where else ""

        # ── Summary mode: counts per category ──
        if summary:
            res = {'mode':'summary', 'region': {'chrom':chrom,'start':start_pos,'end':end_pos}, 'status':'SUCCESS'}
            if source in ('clinvar','all'):
                rows = _q(session, f"SELECT CLINSIG, COUNT(*) N FROM GRAGEN_DB.GRAGEN.CHR22_CLINVAR{wc} GROUP BY CLINSIG ORDER BY CLINSIG")
                res['clinvar'] = {CLINSIG.get(int(r['CLINSIG']), str(r['CLINSIG'])): int(r['N']) for r in rows}
            if source in ('gwas','all'):
                rows = _q(session, f"SELECT TRAIT, COUNT(*) N FROM GRAGEN_DB.GRAGEN.CHR22_GWAS{wc} GROUP BY TRAIT ORDER BY N DESC")
                res['gwas'] = {r['TRAIT']: int(r['N']) for r in rows}
            if source in ('sfari','all'):
                gwc = wc.replace("POSITION BETWEEN", "START_POS >=").replace(" AND ", " AND END_POS <= ", 1) if (start_pos is not None) else wc
                # simpler overlap predicate for gene regions
                sf_where = []
                if chrom: sf_where.append(f"CHROM='{esc(chrom)}'")
                if start_pos is not None and end_pos is not None:
                    sf_where.append(f"END_POS>={int(start_pos)} AND START_POS<={int(end_pos)}")
                sfwc = (" WHERE " + " AND ".join(sf_where)) if sf_where else ""
                rows = _q(session, f"SELECT COUNT(*) N FROM GRAGEN_DB.GRAGEN.AUTISM_GENES{sfwc}")
                res['sfari_gene_count'] = int(rows[0]['N']) if rows else 0
            return res

        # ── Region/row mode: return matching annotation rows (capped) ──
        if source == 'clinvar':
            rows = _q(session, f"""SELECT POSITION, CLINSIG, DISEASE, GENE, ALLELE_ID
                                     FROM GRAGEN_DB.GRAGEN.CHR22_CLINVAR{wc}
                                    ORDER BY CLINSIG DESC, POSITION LIMIT 100""")
            for r in rows: r['SIGNIFICANCE'] = CLINSIG.get(int(r['CLINSIG']), str(r['CLINSIG']))
            return {'mode':'region','source':'clinvar','count':len(rows),'annotations':rows,'status':'SUCCESS'}
        if source == 'gwas':
            rows = _q(session, f"""SELECT POSITION, TRAIT, MAPPED_GENE, RSID, RISK_ALLELE, P_VALUE
                                     FROM GRAGEN_DB.GRAGEN.CHR22_GWAS{wc}
                                    ORDER BY POSITION LIMIT 100""")
            return {'mode':'region','source':'gwas','count':len(rows),'annotations':rows,'status':'SUCCESS'}
        # sfari
        sf_where = []
        if chrom: sf_where.append(f"CHROM='{esc(chrom)}'")
        if start_pos is not None and end_pos is not None:
            sf_where.append(f"END_POS>={int(start_pos)} AND START_POS<={int(end_pos)}")
        sfwc = (" WHERE " + " AND ".join(sf_where)) if sf_where else ""
        rows = _q(session, f"""SELECT GENE, CHROM, START_POS, END_POS, SFARI_SCORE, NOTE
                                 FROM GRAGEN_DB.GRAGEN.AUTISM_GENES{sfwc}
                                ORDER BY START_POS LIMIT 100""")
        return {'mode':'region','source':'sfari','count':len(rows),'annotations':rows,'status':'SUCCESS'}
    except Exception as e:
        return {'error': str(e), 'status':'FAILED'}
$$;

-- Tool 5: Trio pedigree (1000G mother/father/children) over SAMPLE_PEDIGREE
CREATE OR REPLACE PROCEDURE GRAGEN_DB.GRAGEN.TOOL_PEDIGREE(
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
        sid = (sample_id or '').strip().replace("'", "''")
        if not sid:
            return {'error': 'sample_id required', 'status': 'FAILED'}
        rows = session.sql(f"""
            SELECT SAMPLE_ID, FATHER_ID, MOTHER_ID, SEX, RELATIONSHIP
              FROM GRAGEN_DB.GRAGEN.SAMPLE_PEDIGREE WHERE SAMPLE_ID = '{sid}' LIMIT 1
        """).collect()
        if not rows:
            return {'error': f'Sample {sample_id} not in pedigree', 'status': 'FAILED'}
        r = rows[0].as_dict()
        # Children where this sample is a parent
        kids = session.sql(f"""
            SELECT SAMPLE_ID FROM GRAGEN_DB.GRAGEN.SAMPLE_PEDIGREE
             WHERE FATHER_ID = '{sid}' OR MOTHER_ID = '{sid}'
             ORDER BY SAMPLE_ID
        """).collect()
        return {
            'sample':       r.get('SAMPLE_ID'),
            'sex':          r.get('SEX'),
            'father':       r.get('FATHER_ID'),
            'mother':       r.get('MOTHER_ID'),
            'relationship': r.get('RELATIONSHIP'),
            'is_trio_child': bool(r.get('FATHER_ID') or r.get('MOTHER_ID')),
            'children':     [k.as_dict().get('SAMPLE_ID') for k in kids],
            'status': 'SUCCESS',
        }
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
    5. Use tool_query_annotations for clinical/research annotation questions —
       ClinVar (disease, clinical significance, gene), GWAS Catalog (trait
       associations), and SFARI (autism genes). Pass a gene (e.g. SHANK3) to
       auto-locate its region, or a chrom + start_pos/end_pos for a region. Set
       summary=true for counts (e.g. "how many pathogenic variants on chr22").
    6. Use tool_pedigree for family/trio questions — the father and mother sample
       IDs of a sample, whether it is a trio child, and its children. The 1000
       Genomes 3,202-sample set includes 602 parent-offspring trios.
    7. Report population differences objectively — differences in Ti/Tv or variant counts reflect population history and ascertainment, not quality.

    Annotation sources (queryable via tool_query_annotations):
    - clinvar: clinical significance (Benign…Pathogenic), associated disease, gene
    - gwas:    GWAS Catalog trait associations (trait, mapped gene, risk allele, p-value)
    - sfari:   curated autism-associated gene regions with SFARI scores

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
  - tool_spec:
      type: generic
      name: tool_query_annotations
      description: "Query genome annotations from ClinVar (clinical significance + disease + gene), the GWAS Catalog (trait associations), or SFARI (autism genes). Three modes: (1) by region — pass source + chrom + start_pos + end_pos; (2) by gene — pass source + gene (e.g. SHANK3) to auto-resolve its region; (3) summary — pass summary=true with a region/chrom to get counts per clinical significance / trait / gene. Use source='all' with summary for a cross-source overview."
      input_schema:
        type: object
        properties:
          source:
            type: string
            description: "Annotation source: clinvar, gwas, sfari, or all (all only for summary)"
          chrom:
            type: string
            description: "Chromosome, e.g. chr22"
          start_pos:
            type: integer
            description: "Region start (bp)"
          end_pos:
            type: integer
            description: "Region end (bp)"
          gene:
            type: string
            description: "Gene symbol to locate, e.g. SHANK3 — auto-resolves chrom/start/end"
          summary:
            type: boolean
            description: "If true, return counts per significance/trait/gene instead of rows"
        required: [source]
  - tool_spec:
      type: generic
      name: tool_pedigree
      description: "Look up the 1000 Genomes trio pedigree for a sample: its father and mother sample IDs, sex, whether it is a trio child, and any children it is a parent of. Use for questions about family relationships, parents, trios, mother/father of a sample."
      input_schema:
        type: object
        properties:
          sample_id:
            type: string
            description: "1000 Genomes sample ID (e.g. HG00405)"
        required: [sample_id]

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
  tool_query_annotations:
    type: procedure
    identifier: GRAGEN_DB.GRAGEN.TOOL_QUERY_ANNOTATIONS
    execution_environment:
      type: warehouse
      warehouse: GRAGEN_WH
  tool_pedigree:
    type: procedure
    identifier: GRAGEN_DB.GRAGEN.TOOL_PEDIGREE
    execution_environment:
      type: warehouse
      warehouse: GRAGEN_WH
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY(VARCHAR)       TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META(VARCHAR)        TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS(VARCHAR, INTEGER) TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_QUERY_ANNOTATIONS(VARCHAR, VARCHAR, INTEGER, INTEGER, VARCHAR, BOOLEAN) TO ROLE SYSADMIN;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_PEDIGREE(VARCHAR) TO ROLE SYSADMIN;
GRANT USAGE ON AGENT     GRAGEN_DB.GRAGEN.GENOMICS_AGENT                   TO ROLE SYSADMIN;

-- Grant to the service identity role (replace GRAGEN_DB with your role name)
GRANT USAGE ON AGENT     GRAGEN_DB.GRAGEN.GENOMICS_AGENT                   TO ROLE GRAGEN_DB;
GRANT USAGE ON AGENT     GRAGEN_DB.GRAGEN.GENOMICS_AGENT                   TO ROLE GRAGEN_DB_ROLE;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY(VARCHAR)       TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META(VARCHAR)        TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS(VARCHAR, INTEGER) TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_QUERY_ANNOTATIONS(VARCHAR, VARCHAR, INTEGER, INTEGER, VARCHAR, BOOLEAN) TO ROLE GRAGEN_DB;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_PEDIGREE(VARCHAR) TO ROLE GRAGEN_DB;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE GRAGEN_DB;

-- Also grant the app DB role (used by the frontend service identity) so the
-- agent and its tools are callable. CREATE OR REPLACE AGENT drops prior grants,
-- so always re-run these after recreating the agent.
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_COHORT_QUERY(VARCHAR)       TO ROLE GRAGEN_DB_ROLE;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_SAMPLE_META(VARCHAR)        TO ROLE GRAGEN_DB_ROLE;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_FIND_OUTLIERS(VARCHAR, INTEGER) TO ROLE GRAGEN_DB_ROLE;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_QUERY_ANNOTATIONS(VARCHAR, VARCHAR, INTEGER, INTEGER, VARCHAR, BOOLEAN) TO ROLE GRAGEN_DB_ROLE;
GRANT USAGE ON PROCEDURE GRAGEN_DB.GRAGEN.TOOL_PEDIGREE(VARCHAR) TO ROLE GRAGEN_DB_ROLE;

SELECT 'External functions and Cortex Agent created successfully.' AS status;

-- =============================================================================
-- GRAGEN_SLICE + GRAGEN_CLINVAR_SLICE are created near the top of this file as
-- SPCS service functions (bound to GRAGEN_SERVICE). The genome browser uses them.
-- =============================================================================
