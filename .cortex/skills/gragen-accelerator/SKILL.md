---
name: gragen-accelerator
description: "Deploy the GRAGEN Genomics Accelerator on Snowflake Container Services (SPCS). Ingests 1000 Genomes DRAGEN VCF files from a public S3 bucket into an IceChunk Zarr store (same pattern as the weather/NetCDF project), then serves variant slice queries and cohort QC analytics via a FastAPI backend + React/DeckGL frontend. Includes a genome-wide annotation layer in Snowflake-managed Iceberg tables (ClinVar disease/gene, GWAS Catalog, SFARI autism genes) rendered as interactive markers on a 3D DNA helix, with chat-driven control. Use when: deploying GRAGEN accelerator, genomics IceChunk SPCS, 1000 Genomes DRAGEN visualisation, VCF to IceChunk pipeline, genomics annotations Iceberg, ClinVar GWAS SFARI, 3D DNA helix variant viewer, genomics Cortex Agent, variant browser Snowflake."
---

# GRAGEN Genomics Accelerator — SPCS Deployment

End-to-end deployment of a genomics data app on Snowflake Container Services.
**Same architecture as the IceChunk weather project** — VCF data replaces NetCDF data,
genomic position replaces lat/lon, and allele frequency replaces weather variables.

## IceChunk Pattern Mapping

| IceChunk Weather | GRAGEN Genomics |
|---|---|
| NetCDF files on ASDI S3 | VCF.gz + TBI files on 1000genomes-dragen S3 |
| `ingest_uk.py` | `ingest_genomics.py` |
| `latitude[row,col]` / `longitude[row,col]` | `position[i]` (sorted 1D per chromosome) |
| `air_temperature[row,col]` | `allele_freq[i]` (cohort allele frequency) |
| `wind_speed[row,col]` | `het_rate[i]` (heterozygosity rate) |
| Lat/lon bounding box | Chromosome + start_pos + end_pos |
| `ICECHUNK_SLICE_UK(var, lat_min, lat_max, lon_min, lon_max)` | `GRAGEN_SLICE(chrom, start, end)` |
| UK 2km / Global 10km datasets | chr1, chr2, … chr22, chrX |
| Snapshot per forecast run | Snapshot per ingestion batch |
| WEATHER_* saved tables | VARIANT_* saved tables |

## IceChunk Zarr Schema (per chromosome)

```
genomics_repo/           ← IceChunk store on S3 (<your-bucket>, <prefix>/genomics_repo/ prefix)
  chr22/
    position      (int32,   n_variants)  ← sorted VCF POS — coordinate axis
    allele_freq   (float32, n_variants)  ← fraction with ALT allele — main data variable
    het_rate      (float32, n_variants)  ← fraction heterozygous genotypes
    variant_type  (int8,    n_variants)  ← 0=SNP 1=INS 2=DEL 3=MNP
    ref_len       (int8,    n_variants)  ← len(REF)
  chr21/
    position / allele_freq / het_rate / …
  …
```

**Slice operation** (mirrors lat/lon mask):
```python
# Find variants in chr22:20,000,000–25,000,000
lo = np.searchsorted(position, 20_000_000)
hi = np.searchsorted(position, 25_000_001)
result = allele_freq[lo:hi]   # O(log n) range lookup
```

## Architecture

```
Browser (React + DeckGL)
  ↕ HTTPS
Express  ·  port 3001  ·  gragen-accelerator service
  │  /api/direct/variants    → SPCS-internal HTTP → FastAPI → IceChunk on S3
  │  /api/query              → Snowflake SQL → SAMPLE_METRICS table
  │  /api/save-variants       → Snowflake SQL → GRAGEN_SLICE ext fn → FastAPI
  │  /api/agent/chat          → Cortex Agent (GENOMICS_AGENT)
  ↓
FastAPI  ·  port 8080  ·  gragen-service
  │  /slice                  → IceChunk Zarr slice (Snowflake ext fn format)
  │  /direct/variants        → IceChunk Zarr slice (direct, no 20 MB limit)
  │  /seed_genomics          → trigger VCF → IceChunk ingest
  │  /meta                   → store info (chromosomes, sample count, snapshots)
  ↓
IceChunk on S3:  s3://<your-bucket>/<prefix>/genomics_repo/   (your bucket, namespaced by DEPLOY_PREFIX)
  + Public S3:   s3://1000genomes-dragen/           (VCF source during ingest)

Snowflake:
  GRAGEN_DB.GRAGEN schema
  ├── GRAGEN_SERVICE          (SPCS, port 8080)
  ├── GRAGEN_ACCELERATOR_SERVICE  (SPCS, port 3001, public ingress)
  ├── GRAGEN_SLICE(chrom, start, end)  ← external function
  ├── SAMPLE_METRICS table    ← pre-loaded QC metrics for 3,202 samples
  └── GENOMICS_AGENT          ← Cortex Agent
```

---

## Prerequisites

> **Run `bash preflight.sh` first.** It verifies every prerequisite below and fails fast with
> actionable messages: the `snow`/`docker`(+buildx+daemon)/`aws`/`python3` CLIs, a filled-in
> `config.env` with a valid `DEPLOY_PREFIX`, a working Snowflake connection whose active role is
> ACCOUNTADMIN, AWS CLI authentication, and **region colocation** (Snowflake account region ==
> `AWS_REGION`). `setup.sh`, `provision_aws.sh`, and `deploy.sh` each auto-run the relevant subset
> at startup (`provision`→AWS, `deploy`→Docker, `setup`→neither). Override with
> `GRAGEN_SKIP_PREFLIGHT=1`. Flags: `--no-aws`, `--no-docker`.

- `snow` CLI authenticated: `snow connection test -c <CONNECTION>`
- **The connection's Snowflake credential must allow multi-role access including ACCOUNTADMIN.**
  If using a programmatic access token (PAT), create it with **multiple roles** (not bound to a
  single restricted role) and a role of ACCOUNTADMIN — a single-role/restricted PAT blocks
  `USE ROLE` and lacks privileges to create EAIs / the external volume. (Setup runs as the
  connection's role and no longer issues `USE ROLE`, so the connection itself must be ACCOUNTADMIN.)
- Docker with `buildx`
- SYSADMIN + ACCOUNTADMIN on target Snowflake account
- **AWS CLI authenticated** against the (shared) AWS account — env vars / SSO / profile —
  with permission to create an S3 bucket + IAM user/role. `provision_aws.sh` uses these.
- **Bucket region MUST match the Snowflake account region** (`SELECT CURRENT_REGION();`).
  A cross-region bucket makes the variant Zarr ingest 5-10x slower (every IceChunk write
  crosses regions). SFSEHOL accounts are `us-west-2`, so create the bucket in `us-west-2`.
- A filled-in `config.env` (copy from `config.env.example`): just `GRAGEN_CONNECTION`,
  `DEPLOY_PREFIX`, `S3_BUCKET`, `AWS_REGION`. The AWS key/secret + `ICEBERG_ROLE_ARN` are
  **auto-filled by `provision_aws.sh`**. Self-contained — no dependency on the weather project.

> **Multiple SEs, shared AWS account:** each SE has their own Snowflake account but shares one
> AWS account. A unique `DEPLOY_PREFIX` namespaces the shared resources — S3 paths
> (`<bucket>/<prefix>/...`) and IAM identities (`<prefix>_gragen_zarr_user` /
> `<prefix>_gragen_iceberg_role`). One shared bucket; each user's IAM is scoped to their own
> `<prefix>/*`. Snowflake objects are NOT prefixed (already isolated by separate accounts).

---

## Parameters

| Parameter | Example |
|-----------|---------|
| `<CONNECTION>` | `internal-marketplace` (set as `GRAGEN_CONNECTION` in config.env) |
| `<REGISTRY>` | `<account>.registry.snowflakecomputing.com/gragen_db/gragen/gragen_repo` |
| `DEPLOY_PREFIX` | `fsi_london` (lowercase `^[a-z0-9_]+$`; namespaces all storage) |
| S3 bucket | your own `<S3_BUCKET>`; paths `s3://<bucket>/<prefix>/{genomics_repo,clinvar_repo,iceberg}/` |
| Iceberg auth | IAM role `ICEBERG_ROLE_ARN` (external volume); Zarr uses AWS access-key secrets |
| Public source | `s3://1000genomes-dragen` (no credentials needed) |

---

## Deploy the whole accelerator as a skill

This skill **is** the deployment playbook. To hand the full build to someone else
(a customer, a teammate), give them the repo + this skill and let Cortex Code drive it.

**1. Get the repo + skill.** The skill lives at
`.cortex/skills/gragen-accelerator/SKILL.md` inside the `ICECHUNK_GENOMICS` repo, so a
`git clone` of the repo brings the skill with it. Cortex Code auto-discovers skills under
`.cortex/skills/`. To install it standalone instead, copy that folder into
`~/.snowflake/cortex/plugins/gragen-accelerator/` (or share it — see step 2).

**2. (Optional) Share the skill to other users in the account.** Run `/share-skill` in
Cortex Code (publishes it as a Cortex Extension); recipients install it from the catalog
with `/find-skill`.

**3. Prerequisites the operator needs** (see Prerequisites above): `snow` CLI connection,
Docker with `buildx`, their own S3 bucket, an IAM role for the external volume, an AWS access
key, and a filled-in `config.env`. Self-contained — no other project required.

**4. Invoke the skill and follow it end-to-end.** Ask Cortex Code to *"deploy the GRAGEN
accelerator"* (this skill loads) and it walks through Steps 0–9 + the annotation tables +
the genome-wide ingest. In short, the operator runs:

```bash
cp config.env.example config.env                                    # edit prefix/bucket/creds/role
bash setup.sh                                                       # renders SQL, creates volume + secrets
# → add the printed STORAGE_AWS_IAM_USER_ARN + EXTERNAL_ID to ICEBERG_ROLE_ARN's trust policy
snow spcs image-registry login -c "$GRAGEN_CONNECTION"
bash deploy.sh                                                      # build+push+deploy both images
snow sql -f sql/02_external_functions.sql -c "$GRAGEN_CONNECTION"   # ext fns + GENOMICS_AGENT + tools
snow sql -f sql/04_annotation_tables.sql  -c "$GRAGEN_CONNECTION"   # CHR22_CLINVAR + CHR22_GWAS DDL
# seed chr22 variants + ClinVar (Steps 3–4), then load annotation + pedigree rows:
python3 app/build_clinvar_iceberg.py     # + PUT/COPY INTO CHR22_CLINVAR
python3 app/build_gwas_iceberg.py        # + PUT/COPY INTO CHR22_GWAS
snow sql -f app/build_sfari_iceberg.sql  -c "$GRAGEN_CONNECTION"
python3 app/build_pedigree_iceberg.py && snow sql -f app/build_pedigree_iceberg.sql -c "$GRAGEN_CONNECTION"
python3 app/build_sample_metrics.py      # + PUT/COPY INTO SAMPLE_METRICS (Cohort QC + Origins)
# After the out-of-container chr22 ingest job, restart the backend so it re-opens the store:
#   snow sql -c "$GRAGEN_CONNECTION" -q "ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE SUSPEND; ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE RESUME;"
```

**5. Re-apply grants** after any service/agent recreate (see Critical Rules #6, #8–11):
endpoint grants to `PUBLIC`, `SELECT` on Iceberg tables to `PUBLIC`/`GRAGEN_DB_ROLE`, and
`USAGE` on the agent + tool procedures to `GRAGEN_DB`, `GRAGEN_DB_ROLE`, `SYSADMIN`.

---

## Workflow

```
Step 0: Configure (config.env) + Snowflake setup (setup.sh: DB, pool, EAIs, secrets, external volume) + IAM trust
    ↓
Step 1: Build & push Docker images
    ↓
Step 2: Deploy SPCS services + apply grants
    ↓
Step 3: Seed 1000G variants (chr22) into IceChunk  ~2–10 min
    ↓
Step 4: Seed ClinVar (chr22) into IceChunk         ~4–8 min
    ↓
Step 5: Create external functions + Cortex Agent
    ↓
Step 6: Verify
    ↓
Step 7: (Optional) Seed more chromosomes / load SAMPLE_METRICS
```

---

### Step 0: Configure + AWS provision + Snowflake Setup

```bash
cp config.env.example config.env     # edit DEPLOY_PREFIX, S3_BUCKET, AWS_REGION, GRAGEN_CONNECTION
bash preflight.sh                    # verify CLIs, connection, AWS auth, region colocation (fails fast)
bash provision_aws.sh                # shared bucket (if missing) + <prefix>_gragen_zarr_user / _iceberg_role
                                     #   -> writes the IAM-user key + ICEBERG_ROLE_ARN into config.env
bash setup.sh                        # renders sql/*.tmpl, creates DB/pool/EAIs/secrets + GENOMICS_ICEBERG_VOLUME
bash provision_aws.sh --trust        # set the IAM role trust policy from the volume's DESC
```

`provision_aws.sh` uses your ambient AWS CLI credentials (env / SSO / profile; or a gitignored
`aws_temp.env` if present). `setup.sh` creates the external volume; `--trust` then reads
`DESC EXTERNAL VOLUME GENOMICS_ICEBERG_VOLUME` for `STORAGE_AWS_IAM_USER_ARN` +
`STORAGE_AWS_EXTERNAL_ID` and applies them to the role's trust policy automatically (the
chicken-and-egg step). Do this before loading any annotation tables.

**Key note**: All storage is namespaced under your `DEPLOY_PREFIX` inside the shared bucket:
Zarr at `s3://<bucket>/<prefix>/{genomics_repo,clinvar_repo}/`, Iceberg at
`s3://<bucket>/<prefix>/iceberg/`. AWS access-key secrets `GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID`
/ `AWS_SECRET_ACCESS_KEY` are created by `setup.sh` (used by the IceChunk client). The
external volume authenticates separately via the IAM role.

---

### Step 1: Build & Push Docker Images

```bash
snow spcs image-registry login -c <CONNECTION>
bash deploy.sh --build-only
```

---

### Step 2: Deploy SPCS Services

```bash
bash deploy.sh
# Prints the live app URL when complete
```

**EAIs required on `gragen-service`:** `ICECHUNK_S3_EAI` + `GENOMICS_1000G_EAI` + `NCBI_FTP_EAI`  
**EAI required on `gragen-accelerator`:** `GRAGEN_MAP_TILES_EAI`

**After any `ALTER SERVICE`**, re-apply EAIs:
```sql
ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI, NCBI_FTP_EAI);

ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (GRAGEN_MAP_TILES_EAI);
```

**Re-apply endpoint grants** (needed after any service update):
```sql
GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC;
GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE GRAGEN_DB;
GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE SYSADMIN;
```
```

---

### Step 3: Seed chr22 into IceChunk

Trigger via the app UI or directly after services are running:

```bash
curl -X POST https://<URL>/api/direct/seed_genomics \
  -H "Content-Type: application/json" \
  -d '{"chroms": ["chr22"], "max_workers": 16}'
```

**What happens:**
1. Backend lists all 3,202 sample IDs from S3
2. For each sample: pysam reads chr22 variants via HTTPS range request (TBI index)
3. Aggregates allele frequencies across all samples
4. Writes 1D arrays to IceChunk Zarr: `position`, `allele_freq`, `het_rate`, `variant_type`
5. Commits snapshot with tag `chr22_v1_3202samples_<timestamp>`

**Time:** ~2–10 minutes (16 parallel VCF readers, chr22 only)

---

### Step 4: Seed ClinVar (chr22) into IceChunk

Run immediately after Step 3 to populate clinical annotations:

```bash
curl -X POST https://<URL>/api/direct/seed_clinvar \
  -H "Content-Type: application/json" \
  -d '{"chroms": ["chr22"]}'
```

**What happens:**
1. pysam reads ClinVar VCF.gz directly from NCBI FTP via HTTPS range request
2. Encodes clinical significance: 0=Benign → 4=Pathogenic (+ review confidence)
3. Writes 1D arrays per chromosome: `position`, `clinsig`, `revstat`, `allele_id`
4. Commits snapshot to `s3://<your-bucket>/<prefix>/clinvar_repo/`

**Time:** ~4–8 minutes (chr22: ~200K ClinVar variants)

**Verify ClinVar store:**
```bash
curl https://<URL>/api/meta/clinvar
# Should show: chromosomes_in_store: { chr22: { n_variants: ~200000,
#              n_pathogenic: ~5000, n_likely_path: ~8000, n_vus: ~120000 } }
```

---

### Step 5: External Functions + Cortex Agent

```bash
snow sql -f sql/02_external_functions.sql -c <CONNECTION>
```

---

### Step 6: Verify

```bash
# Check services are running
snow spcs service status GRAGEN_SERVICE -c <CONNECTION>

# Check 1000G IceChunk store has chr22 data
curl https://<URL>/api/meta
# Should show: chromosomes_in_store: { chr22: { n_variants: ~120000, ... } }

# Check ClinVar store has chr22 data
curl https://<URL>/api/meta/clinvar
# Should show: chromosomes_in_store: { chr22: { n_pathogenic: ~5000, ... } }

# Test 1000G variant slice
curl https://<URL>/api/direct/variants \
  -H "Content-Type: application/json" \
  -d '{"chrom": "chr22", "start": 20000000, "end": 21000000}'

# Test ClinVar slice
curl https://<URL>/api/direct/clinvar \
  -H "Content-Type: application/json" \
  -d '{"chrom": "chr22", "start": 20000000, "end": 21000000}'
```

---

### Step 7: (Optional) Seed more chromosomes

**Easiest: from the app UI.** The **Data Management** panel (in the left sidebar of the
genome browser) lists every chromosome with its Zarr load status and a **⬇ Seed** button
for any not yet loaded. Clicking it runs `CALL GRAGEN_DB.GRAGEN.SEED_CHROMOSOME('chrN')`,
which launches an **async out-of-container ingest job** on `GRAGEN_INGEST_POOL` (16 workers,
`gragen-service:latest`). The job ingests that chromosome's 1000G VCF into the Zarr store and
**auto-restarts the backend** on completion (so it re-opens the store and serves the new data).
Click **↻ Refresh Status** after a few minutes. How it fits together:

- `SEED_CHROMOSOME(CHROM)` (in `sql/02`) reads bucket/prefix/region from the `GRAGEN_CONFIG`
  table (populated by `setup.sh`) and builds the `EXECUTE JOB SERVICE … ASYNC=TRUE` spec.
- `deploy.sh` pushes the backend as both `:<version>` **and `:latest`** so the job always runs
  the current image.
- `seed_job.py` restarts `RESTART_SERVICE` (the backend) via the SPCS session token when the
  genomics ingest succeeds — the cached repo handle in the running backend does **not** see
  commits made by the out-of-container job, so a SUSPEND/RESUME is required.
- The panel reads Zarr status from `/api/meta` (`chromosomes_in_store`); genome variants are
  Zarr-only (there is no per-chromosome Iceberg table), so there is no "cache to Iceberg" step.

**Programmatic alternatives** (equivalent, for scripting):

```bash
# One chromosome via the stored proc (async, 16-worker pool — same as the UI button):
snow sql -c "$GRAGEN_CONNECTION" -q "CALL GRAGEN_DB.GRAGEN.SEED_CHROMOSOME('chr1')"

# Whole-genome batch via the committed job template (single job, all chroms):
snow sql -c "$GRAGEN_CONNECTION" -f sql/_rendered/run_genome_ingest_job.sql

# In-container (single-threaded, slow — fine for one small chrom, no pool needed):
curl -X POST https://<URL>/api/direct/seed_genomics \
  -d '{"chroms": ["chr1","chr2","chr3","chr4","chr5","chr6","chr7",
       "chr8","chr9","chr10","chr11","chr12","chr13","chr14","chr15",
       "chr16","chr17","chr18","chr19","chr20","chr21","chrX"]}'
```


---

## Genome-Wide Annotation Layer (Iceberg) — v1.0.26

The 3D DNA helix overlays **clinical / research annotations** on top of the cohort
variants. These annotations live in **Snowflake-managed Iceberg tables**, NOT in Zarr.

### Why two storage tiers?

| Data | Store | Why |
|------|-------|-----|
| **Cohort variants** (allele frequency, het rate per position) — millions of rows per chromosome | **IceChunk Zarr** (`genomics_repo/`) | Huge, numeric, range-sliced by `np.searchsorted`. Too large for Iceberg; never materialised to a table. |
| **Annotations** (ClinVar disease/gene, GWAS traits, SFARI genes) — thousands–millions of *reference* rows | **Snowflake Iceberg** (`GENOMICS_ICEBERG_VOLUME`) | Small, categorical, queried by the **frontend directly via `/api/query`**. No backend rebuild needed to add/refresh annotations. |

> **Architectural enabler:** the frontend `/api/query` endpoint runs arbitrary SQL
> against Snowflake. New annotation sources become available the moment their Iceberg
> table is loaded — **no container image rebuild, no `ALTER SERVICE`.**

### Annotation tables

All created with `EXTERNAL_VOLUME='GENOMICS_ICEBERG_VOLUME' ICEBERG_VERSION=2 CATALOG='SNOWFLAKE'`
in `GRAGEN_DB.GRAGEN`. (Table names keep the `CHR22_` prefix for historical reasons but
hold **genome-wide** rows — they are filtered by `CHROM` + `POSITION`.)

| Table | Rows | Builder (re-runnable) | Columns |
|-------|------|-----------------------|---------|
| `CHR22_CLINVAR` | ~4.43M | `app/build_clinvar_iceberg.py` | `CHROM, POSITION, CLINSIG, REVSTAT, ALLELE_ID, REF_LEN, ALT_LEN, DISEASE, GENE` |
| `CHR22_GWAS` | ~10–15K | `app/build_gwas_iceberg.py` | `CHROM, POSITION, TRAIT, MAPPED_GENE, RSID, RISK_ALLELE, P_VALUE` |
| `AUTISM_GENES` | 25 | `app/build_sfari_iceberg.sql` | `GENE, CHROM, START_POS, END_POS, SFARI_SCORE, NOTE` |
| `SAMPLE_PEDIGREE` | 3202 | `app/build_pedigree_iceberg.py` (+`.sql`) | `SAMPLE_ID, FATHER_ID, MOTHER_ID, SEX, RELATIONSHIP` — 1000G trio pedigree; powers father/mother links in the sample panel |

> **`SAMPLE_METRICS`** (a native table, created in `01_setup.sql.tmpl`, ~2504 rows) is loaded by
> `app/build_sample_metrics.py` — population/superpopulation/sex (from the 30x metadata TSV) +
> per-sample QC (coverage, Ti/Tv, dup rate, variant counts) from the public DRAGEN S3. **It powers
> the Cohort QC scatter and the Origins globe** (both blank if it's empty). The Cohort QC query
> filters `mean_coverage IS NOT NULL`, so the ~4 samples lacking metrics files drop out; Origins
> counts all rows. Reproduces what was originally hand-loaded.

`CLINSIG` encoding (matches frontend `CLINSIG_COLORS`): `0=Benign 1=Likely benign
2=VUS 3=Likely pathogenic 4=Pathogenic 5=Conflicting 6=Other`.

### Step 8: Load annotation tables

```bash
# 1. ClinVar (genome-wide, ~4.4M rows) — parses ClinVar VCF via per-chrom TBI byte-range,
#    extracts disease (CLNDN) + gene (GENEINFO). Re-run anytime to refresh.
python3 app/build_clinvar_iceberg.py          # writes /tmp/clinvar_all.csv
snow sql -c <CONNECTION> --warehouse GRAGEN_WH -q "
  CREATE OR REPLACE ICEBERG TABLE GRAGEN_DB.GRAGEN.CHR22_CLINVAR (
    CHROM STRING, POSITION INT, CLINSIG INT, REVSTAT INT, ALLELE_ID INT,
    REF_LEN INT, ALT_LEN INT, DISEASE STRING, GENE STRING)
  EXTERNAL_VOLUME='GENOMICS_ICEBERG_VOLUME' ICEBERG_VERSION=2 CATALOG='SNOWFLAKE'
  BASE_LOCATION='chr22_clinvar/';"
# PUT + COPY INTO from @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE (see load pattern below)

# 2. GWAS Catalog (EBI REST API per trait — associations embed location/gene/p-value)
python3 app/build_gwas_iceberg.py             # writes /tmp/gwas_all.csv
#    table CHR22_GWAS, BASE_LOCATION='chr22_gwas/'

# 3. SFARI autism genes (curated list, no external fetch — single SQL file)
snow sql -c <CONNECTION> --warehouse GRAGEN_WH -f app/build_sfari_iceberg.sql

# 4. Cohort QC metrics → SAMPLE_METRICS (populates Cohort QC + Origins)
python3 app/build_sample_metrics.py           # writes /tmp/sample_metrics.csv (~2504 samples)
snow sql -c <CONNECTION> --warehouse GRAGEN_WH -q "
  PUT file:///tmp/sample_metrics.csv @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE OVERWRITE=TRUE AUTO_COMPRESS=TRUE;
  COPY INTO GRAGEN_DB.GRAGEN.SAMPLE_METRICS
    (sample_id,population,superpopulation,sex,mean_coverage,pct_duplicates,pct_mapped,
     total_reads,mapped_reads,dup_reads,total_variants,snp_count,ins_count,del_count,
     titv_ratio,het_count,hom_count,het_hom_ratio)
    FROM @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE/sample_metrics.csv
    FILE_FORMAT=(TYPE=CSV SKIP_HEADER=1 FIELD_OPTIONALLY_ENCLOSED_BY='\"' EMPTY_FIELD_AS_NULL=TRUE);"
```

**Load pattern (CSV → Iceberg via stage):**
```sql
PUT file:///tmp/clinvar_all.csv @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE
  OVERWRITE=TRUE AUTO_COMPRESS=TRUE;
COPY INTO GRAGEN_DB.GRAGEN.CHR22_CLINVAR
  FROM @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE/clinvar_all.csv
  FILE_FORMAT=(TYPE=CSV SKIP_HEADER=1 FIELD_OPTIONALLY_ENCLOSED_BY='"' EMPTY_FIELD_AS_NULL=TRUE);
```

### Step 9: Genome-wide variant ingest (Zarr only, per-chromosome commit)

`ingest_genomics.py` commits **per chromosome** (fresh writable session + commit + tag
inside the loop). Each chromosome becomes queryable the moment it finishes, and a crash
mid-run loses only the in-flight chromosome. Sample data is **never** written to Iceberg.

```bash
# Trigger remaining chromosomes (chr22 already seeded). Smallest-first for fast wins.
curl -X POST https://<URL>/api/direct/seed_genomics \
  -d '{"chroms": ["chr21","chr19","chr20","chr18","chr17","chr16","chr15","chr14",
       "chr13","chr12","chr11","chr10","chr9","chr8","chr7","chr6","chr5","chr4",
       "chr3","chr2","chr1","chrX"]}'
```

### Frontend: multi-source annotation UI

- **`types.ts`** — `GenomeAnnotation { source, pos, label, sublabel?, color, link?, clinsig?, start?, end? }`,
  `AnnoSource = 'clinvar' | 'gwas' | 'sfari'`, `ANNO_SOURCE_LABELS`.
- **`DNAHelix.tsx`** — `AnnoMarker` renders source-specific shapes (icosahedron=ClinVar,
  octahedron=GWAS, box=SFARI gene) on stalks off the backbone; hovering pauses spin,
  flies the camera in (`CameraRig`), and shows a generalized annotation card. A source
  dropdown + (ClinVar-only) significance filter live in the top-right control bar.
- **`GenomicsViewer.tsx`** — `loadAnnotations()` queries the relevant Iceberg table via
  `/api/query` for the current `chrom`/region and maps rows → `GenomeAnnotation[]`.
  `applyChatIntent()` parses chat for: pathogenic filter, ClinVar/GWAS/SFARI source switch,
  chromosome/region jump, "jump to <gene>" (queries `AUTISM_GENES`), and sample gender switch.
  Sparse sources (GWAS/SFARI) auto-navigate (`goToRegion`) to where data exists.
- **Trio family** — the sample panel shows clickable **father/mother** buttons (from
  `SAMPLE_PEDIGREE`) that switch the active sample, for parent-vs-child comparison.

### Cortex Agent tools (GENOMICS_AGENT)

The agent uses `type: generic` tools backed by Python stored procedures (warehouse exec env):

| Tool | Procedure | Purpose |
|------|-----------|---------|
| `tool_cohort_query` | `TOOL_COHORT_QUERY` | QC stats grouped by superpopulation |
| `tool_sample_meta` | `TOOL_SAMPLE_META` | QC metrics for one sample |
| `tool_find_outliers` | `TOOL_FIND_OUTLIERS` | top/bottom samples by metric |
| `tool_query_annotations` | `TOOL_QUERY_ANNOTATIONS` | ClinVar/GWAS/SFARI by region, gene, or summary |
| `tool_pedigree` | `TOOL_PEDIGREE` | trio father/mother/children for a sample |
| `tool_cohort_variants` | `TOOL_COHORT_VARIANTS` | **cohort allele frequency joined to annotations** — reads per-position `allele_freq` from the Zarr store via `GRAGEN_SLICE` and merges with ClinVar/GWAS on `(CHROM, POSITION)`. Gene or chrom+start+end; region capped 2 Mb. No materialization (genomes stay in Zarr). |

> **Gotcha:** Snowpark `Row` → use `row.as_dict()`, not `dict(row)` (else "dictionary update
> sequence element"). `CREATE OR REPLACE AGENT` **drops all grants** — re-grant `USAGE ON AGENT`
>           + every tool procedure to `GRAGEN_DB`, `GRAGEN_DB_ROLE`, `SYSADMIN` (the frontend
> service identity), or the agent API returns 401.
>
> **`tool_cohort_variants` depends on the backend service** — it calls the `GRAGEN_SLICE`
> service function, so `GRAGEN_SERVICE` must be READY (and `GRAGEN_SLICE` granted to the agent's
> role) or the tool returns "Cohort store unavailable".

### Origins globe + theme

- **3D globe** (`CohortGlobe.tsx`) uses **react-three-fiber** (the deck.gl `_GlobeView` is
  experimental and renders blank). Earth texture bundled at `public/earth-blue-marble.jpg`.
  The `<Canvas>` needs an explicit container height or it collapses.
- **Dark Snowflake theme** (`src/index.css`): tokens `--bg #0D1117 / --surface #161B22 /
  --surface-2 #1E2A3A / --border #2D3F53 / --accent #29B5E8`; branded sidebar + grouped nav +
  `app-header` + panels. Visualization canvases stay near-black (`#03060f`).

---

1. **Both IceChunk stores must be seeded before queries work:**
   - `genomics_repo/` (1000G variants) → seed via `POST /api/direct/seed_genomics`
   - `clinvar_repo/` (ClinVar annotations) → seed via `POST /api/direct/seed_clinvar`
   - `/meta` and `/meta/clinvar` show which chromosomes are available.

2. **Bring your own bucket + unique prefix** — Zarr prefixes are `<prefix>/genomics_repo/` and `<prefix>/clinvar_repo/` inside your `S3_BUCKET`. The `GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID` secret must have read/write on `s3://<S3_BUCKET>/<prefix>/*`. Set in `config.env`; created by `setup.sh`.

3. **VCF ingestion uses boto3/urllib HTTP range requests via TBI index** (NOT pysam):
   - pysam/libcurl does NOT route through SPCS's EAI proxy — causes silent hangs
   - boto3 (for S3) and urllib (for NCBI HTTPS) DO use the proxy correctly
   - `ingest_genomics.py` downloads TBI index → finds byte range → boto3 S3 Range request
   - `ingest_clinvar.py` downloads TBI index → finds byte range → urllib Range request

4. **Seed via EXECUTE JOB SERVICE** (not service functions or direct HTTP):
   - Service restarts kill background threads — EXECUTE JOB SERVICE is isolated
   - `GRAGEN_INGEST_POOL` (CPU_X64_L, 16 vCPU) with `AUTO_SUSPEND_SECS=60`
   - Genomics seed: 3201 samples, 8 parallel workers, ~25 min for chr22
   - ClinVar seed: single file, ~2 min for chr22
   ```sql
   -- Genomics chr22 seed:
   EXECUTE JOB SERVICE
     IN COMPUTE POOL GRAGEN_INGEST_POOL
     NAME = GRAGEN_DB.GRAGEN.GRAGEN_SEED_JOB
     EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI)
     FROM SPECIFICATION $$
   spec:
     containers:
     - name: seed
       image: /gragen_db/gragen/gragen_repo/gragen-service:<VERSION>
       command: ["python3", "/app/seed_job.py"]
       env:
         SEED_TYPE: genomics
         SEED_CHROMS: chr22
         ICECHUNK_BUCKET: <your-bucket>
         ICECHUNK_GENOMICS_PREFIX: <prefix>/genomics_repo
         AWS_DEFAULT_REGION: <your-region>
         INGEST_WORKERS: "8"
       secrets:
       - snowflakeSecret: GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID
         envVarName: AWS_ACCESS_KEY_ID
       - snowflakeSecret: GRAGEN_DB.GRAGEN.AWS_SECRET_ACCESS_KEY
         envVarName: AWS_SECRET_ACCESS_KEY
   $$;

   -- ClinVar chr22 seed (same but SEED_TYPE: clinvar, use NCBI_FTP_EAI):
   EXECUTE JOB SERVICE ...
   ```
   After each DROP + re-run, verify with: `SELECT GRAGEN_DB.GRAGEN.GRAGEN_META();`
   - ClinVar: requires `NCBI_FTP_EAI` on `gragen-service`
   - Without the EAI, ingest fails silently (pysam connection timeout)

4. **Position arrays are sorted** — slicing uses `np.searchsorted` O(log n), not a full scan.

5. **20 MB external function limit applies to `GRAGEN_SLICE` and `CLINVAR_SLICE`**. Large regions are auto-downsampled by stride. Use `/api/direct/variants` and `/api/direct/clinvar` for full resolution.

6. **GRANT SERVICE ROLE required after every ALTER SERVICE** — SPCS drops endpoint grants when the service spec is updated. Always re-run:
   ```sql
   GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC;
   GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE GRAGEN_DB;
   ```

7. **chr22 first** — smallest autosome, validates the full pipeline in ~15 minutes total.

8. **Backend `ALTER SERVICE` spec MUST carry the full env + secrets + both EAIs.**
   `ALTER SERVICE … FROM SPECIFICATION` **replaces** the entire spec — any omitted
   `secrets:` / `env:` block is dropped, silently removing S3 credentials. The
   `gragen-service` spec (in `deploy.sh` and `sql/03_deploy_services.sql.tmpl`) must always include:
   ```yaml
   env: { PYTHONUNBUFFERED: "1", ICECHUNK_BUCKET: <your-bucket>,
          ICECHUNK_GENOMICS_PREFIX: <prefix>/genomics_repo, ICECHUNK_CLINVAR_PREFIX: <prefix>/clinvar_repo,
          AWS_DEFAULT_REGION: <your-region>, INGEST_WORKERS: "16" }
   secrets:
   - { snowflakeSecret: { objectName: GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID }, envVarName: AWS_ACCESS_KEY_ID }
   - { snowflakeSecret: { objectName: GRAGEN_DB.GRAGEN.AWS_SECRET_ACCESS_KEY }, envVarName: AWS_SECRET_ACCESS_KEY }
   ```
   then `SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI);`
   Symptom of a stripped spec: backend 503 / IceChunk repo not found after a backend deploy.

9. **Annotations live in Iceberg, sample/variant data lives in Zarr.** Never materialise
   cohort variants to a Snowflake table (size). Add annotation sources by loading an Iceberg
   table — the frontend queries it via `/api/query` with no backend rebuild.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Chromosome chrX not in store` | Run seed_genomics for that chromosome first |
| `Store not ready: IceChunk repo not found` | Deploy completed but ingest not yet run — trigger seed_genomics |
| `pysam: SSL/connection error` | Check GENOMICS_1000G_EAI is applied to gragen-service |
| VCF ingest slow | Increase `max_workers` (default 16). Check SPCS compute pool is CPU_X64_S not XS |
| `ICECHUNK_S3_EAI` missing | Re-apply EAI after ALTER SERVICE |
| `allele_freq all zeros` | VCF GT field not found — verify sample ID matches VCF header |
| ClinVar overlay not loading | Run `seed_clinvar` first. Check `/api/meta/clinvar` — should show chromosomes. |
| ClinVar 502 error | Check `NCBI_FTP_EAI` is applied to `gragen-service` |
| 403 Forbidden after service update | Re-apply endpoint grants: `GRANT SERVICE ROLE ...!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC` |

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| v1.0.44 | 2026-06-09 | **Family Constellation spacing.** Clustered modes placed each group on a large ring → big empty centre + lopsided islands. Switched cluster centres to a **centered grid** (`cols=ceil(√groups)`, uniform `cell = 2·maxLocalR + 4`), tightened/normalised the decorative spiral (`c` 1.25→1.7) and pulled the camera back (`z` 48→82) so all modes (spiral / 5-island ancestry / ~18-cluster population) frame consistently and fill the viewport. Verified on the live app via screenshot. |
| v1.0.43 | 2026-06-09 | **Fixed Family Constellation grouping** (ancestry & population modes looked identical — one giant blob + a few tiny islands). Cause: trio **children are excluded from the 2,504-sample unrelated `SAMPLE_METRICS` panel**, so joining superpop/population on the child returned NULL for **597 of 602** trios → all collapsed into one "NA" group. Fix: `COALESCE` superpopulation/population across **child → father → mother** (parents are in the panel: ~545/555) → ancestry now resolves for **593/602** trios across all 5 superpopulations / 18 populations, so the two clustered layouts are distinct. |
| v1.0.42 | 2026-06-09 | **Family Constellation: meaningful clustering + filter + better pause.** Added layout-mode buttons — **Spiral** (decorative), **By ancestry** (5 superpopulation islands on a ring), **By population** (26 1000G-population clusters, ordered by superpop so colors form arcs) — with smooth lerp transitions between layouts (each glyph imperatively lerps to its target so r3f doesn't snap). Now distance is meaningful in the clustered modes (shared ancestry/population). Legend became a **superpopulation filter** (click to show/hide; layout reflows to the visible set). Pause UX fixed: prominent "⏸ Pause spin" toggle **and** auto-pause while the pointer is over the canvas (rotation made nodes hard to click). Query now also pulls `POPULATION`. Frontend-only. |
| v1.0.41 | 2026-06-09 | **New "Family Constellation" view + classic pedigree chart.** New sidebar view `👪 Families` (`FamilyConstellation.tsx`, react-three-fiber) renders all **602 parent–offspring trios** as a phyllotaxis-spiral galaxy of family glyphs — father (cube ♂) + mother (sphere ♀) joined by a couple bar, child dropped below — colored by the child's superpopulation (from `SAMPLE_METRICS` join; grey fallback). Hover → family card; click any node → opens that sample in the Genome Browser. One `/api/query` over `SAMPLE_PEDIGREE` ⋈ `SAMPLE_METRICS`; no backend/SQL change. Also added an inline SVG **classic pedigree** (♂ square / ♀ circle / couple bar / sib-drop, proband highlighted) to the Genome-Browser sample panel. Frontend-only rebuild. |
| v1.0.40 | 2026-06-09 | **Fixed: clicking a 3D-helix annotation blanked the helix.** Clicking an annotation marker raycasts through to a variant behind it → `onExplain` sends an "Explain the variant at **chr22**:50,123,456…" message to the chat → `applyChatIntent` matched the literal `chr22` and fired `goToRegion('chr22', 1_000_000, 5_000_000)` → chr22's empty acrocentric arm has no variants → helix dropped to the "🧬 Fetch variants" placeholder. Fix (`GenomicsViewer.tsx` `ChatPanel`): auto-injected context messages now pass `skipIntent=true` so only genuinely user-typed messages drive navigation. Frontend-only rebuild. |
| v1.0.39 | 2026-06-09 | **Agent gains cohort allele frequency + annotation joins.** New `tool_cohort_variants` (`TOOL_COHORT_VARIANTS` proc) reads per-position cohort `allele_freq` from the Zarr store via the `GRAGEN_SLICE` service function and merges it with ClinVar/GWAS on `(CHROM, POSITION)` — answering "allele frequency at pathogenic ClinVar sites in <gene/region>". No `CHR22_VARIANTS` materialization (genomes stay in Zarr); region capped 2 Mb. SQL-only change — re-run `sql/02` (recreates procs + agent + grants), no image rebuild. Validated on FSI: proc + gene mode work, and the agent calls the tool end-to-end (SHANK3: 500 ClinVar sites, 68 with cohort AF, mean 0.51%). The join key was never missing — it's the genomic coordinate, already on every annotation table + Zarr `position`. |
| v1.0.38 | 2026-06-09 | **In-UI chromosome loader now works end-to-end.** The Data Management panel was wired to objects that were never created (`GRAGEN_SEED_GENOMICS`, `MATERIALIZE_ICEBERG_TABLES`, `CHR22_VARIANTS`, `GRAGEN_META`) → every action errored. Replaced with a real path: new `SEED_CHROMOSOME(CHROM)` stored proc (`sql/02`) launches an async `EXECUTE JOB SERVICE` on `GRAGEN_INGEST_POOL` (16 workers, `gragen-service:latest`); reads bucket/prefix/region from new `GRAGEN_CONFIG` table (`sql/01`, populated by setup.sh); `deploy.sh` now also pushes the backend `:latest`; `seed_job.py` auto-restarts the backend (`RESTART_SERVICE`) on success so it re-opens the Zarr store. Panel rewritten to read Zarr status from `/api/meta` and dropped the obsolete Iceberg-materialization + ClinVar-refresh controls (genomes are Zarr-only). Validated on FSI: chr21 ingest launched + ran with 16 workers. |
| v1.0.37 | 2026-06-09 | **Committed `preflight.sh`** — prerequisite check that fails fast before any deploy. Verifies the `snow`/`docker`(+buildx+running daemon)/`aws`/`python3` CLIs, `config.env` presence + required vars + valid `DEPLOY_PREFIX`, a working Snowflake connection whose active role is ACCOUNTADMIN, AWS CLI authentication (`sts get-caller-identity`), and **region colocation** (`CURRENT_REGION()` vs `AWS_REGION`, the slow-ingest trap). `--no-aws` / `--no-docker` flags + `GRAGEN_SKIP_PREFLIGHT=1` override. Auto-invoked by `setup.sh` (`--no-aws --no-docker`), `provision_aws.sh` (`--no-docker`), and `deploy.sh` (`--no-aws`). |
| v1.0.36 | 2026-06-09 | Fixed backend `direct_metrics` (Cohort QC + Origins) — same coverage-key + `MAPPING/ALIGNING SUMMARY` / `VARIANT CALLER POSTFILTER` section-filter fix as the offline loader; rebuilt + redeployed `gragen-service`. |
| v1.0.33 | 2026-06-09 | Committed `app/build_sample_metrics.py` — reproducible loader for the `SAMPLE_METRICS` table (was hand-loaded before; no committed loader). Reads population/superpopulation/sex (30x metadata TSV) + per-sample QC (coverage, Ti/Tv, dup, variant counts) from public DRAGEN S3, writes CSV → PUT/COPY. Powers **Cohort QC** + **Origins** (both were blank on a fresh deploy). Fixed coverage key ("Average **sequenced** coverage over genome") + restricted parsing to the `MAPPING/ALIGNING SUMMARY` / `VARIANT CALLER POSTFILTER` sections (PER RG rows were overwriting totals). Also fixed the genome browser: recreated `GRAGEN_SLICE`/`GRAGEN_CLINVAR_SLICE` as SPCS service functions; documented backend restart after out-of-container ingest. |
| v1.0.32 | 2026-06-09 | **Multi-SE shared-AWS provisioning.** Committed `provision_aws.sh` (prefix-parameterized): one shared S3 bucket + per-`DEPLOY_PREFIX` IAM user (`<prefix>_gragen_zarr_user`, scoped to `<prefix>/*`) + role (`<prefix>_gragen_iceberg_role`); auto-fills the AWS key/secret + `ICEBERG_ROLE_ARN` into `config.env` (secret never echoed); `--trust` phase reads the external-volume `DESC` and sets the role trust policy automatically. Model: each SE has their own Snowflake account (no Snowflake-object prefixing) but shares one AWS account (prefix isolates S3 + IAM). |
| v1.0.31 | 2026-06-09 | **Self-contained / bring-your-own-bucket.** New `config.env` + `setup.sh` (python-rendered SQL templates) let a deployer supply their own `S3_BUCKET` + unique `DEPLOY_PREFIX` that namespaces all storage (`<prefix>/genomics_repo`, `/clinvar_repo`, `/iceberg`). `setup.sh` now **creates `GENOMICS_ICEBERG_VOLUME`** (previously never created) via `STORAGE_AWS_ROLE_ARN` + prints the IAM trust-policy gate. Secrets moved to self-contained `GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (dropped `ICECHUNK_DB` dependency + naming bug). Added `sql/04_annotation_tables.sql` (CLINVAR/GWAS DDL + load stage). SQL files are now `.sql.tmpl`. |
| v1.0.30 | 2026-06-09 | Trio family links (clickable father/mother in sample panel) from new `SAMPLE_PEDIGREE` Iceberg table (1000G 3,202 pedigree). Gosling tracks now fill the viewport height. Agent gains `tool_pedigree` (father/mother/children). |
| v1.0.29 | 2026-06-09 | Dark Snowflake "module" restyle: ICECHUNK palette (`#0D1117/#161B22/#2D3F53`, accent `#29B5E8`), branded sidebar + grouped nav + app-header + panels (`src/index.css`, `GenomicsViewer.tsx`). Viz canvases stay near-black. |
| v1.0.28 | 2026-06-09 | Origins globe rebuilt with react-three-fiber + bundled Earth texture (deck.gl `_GlobeView` rendered blank). Annotation auto-navigation for sparse GWAS/SFARI sources (`goToRegion`). Fixed "annotations always 0" (GRANT SELECT on Iceberg tables to PUBLIC). Added `tool_query_annotations` to GENOMICS_AGENT; fixed `dict(row)`→`as_dict()` in all agent tools; re-granted agent USAGE after recreate. |
| v1.0.26 | 2026-06-08 | Genome-wide annotation layer in Iceberg: `CHR22_CLINVAR` (+DISEASE/GENE, 4.43M rows), `CHR22_GWAS` (EBI GWAS Catalog), `AUTISM_GENES` (SFARI, 25 genes). Multi-source 3D helix markers (ClinVar/GWAS/SFARI) with source dropdown, hover-zoom cards, chat-driven control (`applyChatIntent`). `ingest_genomics` commits per-chromosome (durable/incremental). Fixed `deploy.sh` backend spec dropping AWS secrets + `ICECHUNK_S3_EAI`. |
| v1.0.25 | 2026-06-08 | ClinVar annotations on the 3D helix (hover marker → zoom + disease card). |
| v1.0.24 | 2026-06-08 | Click a helix variant → agent explains; chat panel zooms the helix to the region. |
| v1.0.23 | 2026-06-08 | DNA-accurate double helix (base-pair rungs, zoom); fixed gosling `rgb2hex` (pixi.js pinned ~6.5.10). |
| v1.0.22 | 2026-06-08 | Fixed blank screen — rebuilt frontend with React 18 deps (was React 19/drei 10). |
| v1.0.17 | 2026-06-08 | Production release: chr22 genomics (1.93M variants, 3201 samples) + ClinVar seeded. Replaced pysam HTTP with boto3/urllib TBI range requests (SPCS EAI proxy fix). seed_job.py for EXECUTE JOB SERVICE. POST /meta endpoint. int8→int16 for ref_len. Zarr create_array dtype fix. |
| v1.0.3 | 2026-06-07 | ClinVar overlay: IceChunk clinvar_repo/, /seed_clinvar, /direct/clinvar, CLINSIG overlay track in genome browser, CLINVAR_SLICE external function, NCBI_FTP_EAI |
| v1.0.2 | 2026-06-07 | CSP fix (remove Google Fonts), GENOMICS_1000G_EAI created, GRAGEN_DB role + endpoint grants |
| v1.0.1 | 2026-06-07 | Initial build: chr22 IceChunk store, cohort QC scatter, genome browser, GENOMICS_AGENT |

---

*This skill is updated after each deployment. Check version history for latest changes.*
