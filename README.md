# GRAGEN Genomics Accelerator

A genomics data application on **Snowflake Container Services (SPCS)** that ingests
**1000 Genomes DRAGEN** variant data into an **IceChunk Zarr** store on S3 and visualises
it through an interactive **3D DNA helix**, cohort QC dashboards, and a genome browser —
with a **Cortex Agent** chat assistant and genome-wide clinical/research annotations.

Built on the same IceChunk pattern as the weather/NetCDF accelerator: genomic position
replaces lat/lon, allele frequency replaces weather variables.

---

## What it does

- **Cohort QC** — coverage, Ti/Tv, het/hom, duplicate rates across 3,202 samples (DeckGL scatter).
- **Geographic origins** — sample populations mapped by superpopulation.
- **Genome browser** — variant density + individual variants for any region, with a ClinVar overlay.
- **3D DNA helix** — variants as glowing spheres on a double helix; click one and the Cortex
  Agent explains it. Overlays genome-wide annotations from three sources you can switch between:
  - 🏥 **ClinVar** — clinical significance + disease + gene (pathogenic-only filter available)
  - 📈 **GWAS Catalog** — trait associations, mapped gene, risk allele, p-value
  - 🧩 **SFARI** — autism gene regions
  Hover any annotation marker and the camera flies in to it with a detail card.
- **Genomics Agent** — natural-language chat that can also drive the UI (filter pathogenic,
  switch annotation source, jump to a chromosome/region or gene, switch sample by sex).

---

## Architecture (two storage tiers)

```
Browser (React + DeckGL + three.js)
  ↕ HTTPS
Express · port 3001 · gragen-accelerator service
  │  /api/direct/variants  → FastAPI → IceChunk Zarr (cohort variants)
  │  /api/query            → Snowflake SQL → Iceberg annotation tables + SAMPLE_METRICS
  │  /api/agent/chat       → Cortex Agent (GENOMICS_AGENT)
  ↓
FastAPI · port 8080 · gragen-service
  ↓
┌─ IceChunk Zarr on S3 (s3://<your-bucket>/<prefix>/genomics_repo/, clinvar_repo/) ─ cohort variants (huge)
└─ Snowflake Iceberg (GENOMICS_ICEBERG_VOLUME @ <your-bucket>/<prefix>/iceberg/) ─ annotations (categorical)
```

**Bring your own storage.** A deployment supplies its own S3 bucket and a unique
`DEPLOY_PREFIX` (set in `config.env`). Every path is namespaced under that prefix, so any
number of accounts can deploy into one or many buckets without colliding:
`s3://<bucket>/<prefix>/{genomics_repo,clinvar_repo,iceberg}/`.

| Data | Store | Why |
|------|-------|-----|
| Cohort variants (allele freq / het rate, millions of rows per chrom) | **IceChunk Zarr** | Range-sliced with `np.searchsorted`; too large for a table — never materialised. |
| Annotations (ClinVar / GWAS / SFARI reference rows) | **Snowflake Iceberg** | Queried by the frontend via `/api/query`; new sources need no backend rebuild. |

---

## Project structure

```
.
├── app/                      FastAPI backend + ingest/build scripts
│   ├── main.py               API: /direct/variants, /direct/clinvar, /seed_genomics, /meta
│   ├── icechunk_client.py    IceChunk repo open/create (S3 auth via env)
│   ├── ingest_genomics.py    VCF → Zarr ingest (commits per chromosome)
│   ├── ingest_clinvar.py     ClinVar VCF → Zarr ingest
│   ├── build_clinvar_iceberg.py   ClinVar → CSV → Iceberg (disease/gene)  [re-runnable]
│   ├── build_gwas_iceberg.py      EBI GWAS Catalog → CSV → Iceberg        [re-runnable]
│   ├── build_sfari_iceberg.sql    SFARI autism genes → Iceberg            [re-runnable]
│   └── seed_job.py           EXECUTE JOB SERVICE entrypoint
├── gragen-accelerator/       React + Vite frontend
│   └── src/components/        DNAHelix.tsx, GenomicsViewer.tsx, …
├── sql/                      01_setup.sql.tmpl, 02_external_functions.sql,
│                             03_deploy_services.sql.tmpl, 04_annotation_tables.sql,
│                             run_genome_ingest_job.sql.tmpl  (.tmpl → rendered by setup.sh)
├── config.env.example        deployer inputs: bucket, prefix, region, creds, IAM role ARN
├── setup.sh                  one-time Snowflake setup (renders SQL, creates volume + secrets)
├── provision_aws.sh          one-time AWS setup (shared bucket + per-prefix IAM user/role)
├── config.env.example        deployer inputs: prefix, bucket, region (creds auto-filled)
├── Dockerfile · deploy.sh · VERSION · GENOMICS_SV.yaml
├── AGENT.md                  Operational guide for Cortex Code (CoCo)
└── .cortex/skills/gragen-accelerator/SKILL.md   Full step-by-step deployment playbook
```

---

## Multiple SEs on a shared AWS account

Each SE has their **own Snowflake account** but everyone **shares one AWS account**. A unique
`DEPLOY_PREFIX` (you pick it in `config.env`) namespaces everything that's shared:

- S3 paths: `s3://<bucket>/<prefix>/{genomics_repo,clinvar_repo,iceberg}/` (one shared bucket)
- IAM user: `<prefix>_gragen_zarr_user` — scoped to `s3://<bucket>/<prefix>/*` only
- IAM role: `<prefix>_gragen_iceberg_role` — for the Iceberg external volume

Snowflake objects (`GRAGEN_DB`, `GENOMICS_ICEBERG_VOLUME`, the agent, …) are **not** prefixed —
they're already isolated by living in your own Snowflake account. So two SEs just pick two
different prefixes and never collide. `provision_aws.sh` creates the shared bucket only if it's
missing and reuses it otherwise.

---

## Quick start

> Prerequisites: `snow` CLI authenticated to your own Snowflake account with a credential that
> allows **multi-role access including ACCOUNTADMIN** (a single-role/restricted PAT blocks
> `USE ROLE` and can't create EAIs / the external volume), Docker with `buildx`, and AWS CLI
> authenticated against the shared AWS account (env vars / SSO / profile) with permission to
> create an S3 bucket + IAM user/role. Full detail is in the skill.
>
> Run **`bash preflight.sh`** first — it verifies all of the above (CLIs, connection + ACCOUNTADMIN
> role, AWS auth, Docker daemon/buildx) plus **region colocation** (Snowflake region must match
> `AWS_REGION`) and fails fast with clear messages. `setup.sh` / `provision_aws.sh` / `deploy.sh`
> auto-run the relevant subset.

```bash
# 0. Configure: pick a unique prefix + the shared bucket/region (creds auto-filled later)
cp config.env.example config.env        # edit DEPLOY_PREFIX, S3_BUCKET, AWS_REGION, GRAGEN_CONNECTION
bash preflight.sh                       # verify prerequisites (fails fast)

# 1. Provision AWS (shared bucket + your prefixed IAM user/role). Writes the IAM-user
#    key + ICEBERG_ROLE_ARN back into config.env automatically.
bash provision_aws.sh

# 2. One-time Snowflake setup: renders SQL, creates DB/pool/EAIs/secrets +
#    GENOMICS_ICEBERG_VOLUME (prints the IAM trust-policy details).
bash setup.sh

# 3. Finalize the IAM role trust policy from the volume's DESC (closes the loop).
bash provision_aws.sh --trust

# 4. Build + push images, deploy both SPCS services
snow spcs image-registry login -c "$GRAGEN_CONNECTION"
bash deploy.sh                          # prints the live app URL

# 5. Seed chr22 variants + ClinVar into IceChunk (via the app, see SKILL.md Step 3–4)
# 6. External functions + Cortex Agent
snow sql -f sql/02_external_functions.sql -c "$GRAGEN_CONNECTION"

# 7. Load genome-wide annotation tables (Iceberg)
snow sql -f sql/04_annotation_tables.sql -c "$GRAGEN_CONNECTION"   # creates CHR22_CLINVAR + CHR22_GWAS
python3 app/build_clinvar_iceberg.py    # then PUT + COPY INTO CHR22_CLINVAR
python3 app/build_gwas_iceberg.py       # then PUT + COPY INTO CHR22_GWAS
snow sql -f app/build_sfari_iceberg.sql -c "$GRAGEN_CONNECTION"
python3 app/build_pedigree_iceberg.py && snow sql -f app/build_pedigree_iceberg.sql -c "$GRAGEN_CONNECTION"

# 8. Load cohort QC metrics (populates Cohort QC + Origins views)
python3 app/build_sample_metrics.py     # writes /tmp/sample_metrics.csv (~2504 samples, pop/superpop/sex + QC)
# then PUT + COPY INTO SAMPLE_METRICS (explicit column list — see below):
snow sql -c "$GRAGEN_CONNECTION" --warehouse GRAGEN_WH -q "
  PUT file:///tmp/sample_metrics.csv @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE OVERWRITE=TRUE AUTO_COMPRESS=TRUE;
  COPY INTO GRAGEN_DB.GRAGEN.SAMPLE_METRICS
    (sample_id,population,superpopulation,sex,mean_coverage,pct_duplicates,pct_mapped,
     total_reads,mapped_reads,dup_reads,total_variants,snp_count,ins_count,del_count,
     titv_ratio,het_count,hom_count,het_hom_ratio)
    FROM @GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE/sample_metrics.csv
    FILE_FORMAT=(TYPE=CSV SKIP_HEADER=1 FIELD_OPTIONALLY_ENCLOSED_BY='\"' EMPTY_FIELD_AS_NULL=TRUE);"

# 9. After any out-of-container ingest (e.g. the chr22 Zarr job), restart the backend so it
#    re-opens the IceChunk store: ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE SUSPEND; RESUME;
```

### Redeploy after code changes

```bash
bash deploy.sh --accel-only   --accel-version X.Y.Z    # frontend only (~4 min)
bash deploy.sh --backend-only --service-version X.Y.Z  # backend only
```

The version lives in `VERSION`. **Always bump the version** when deploying so SPCS pulls
the new image.

---

## Deploy the whole thing as a skill

This project ships a **Cortex Code skill** that is the full deployment playbook —
`.cortex/skills/gragen-accelerator/SKILL.md`. Hand someone the repo + skill and Cortex Code
can reproduce the entire accelerator end-to-end.

1. **Get it** — `git clone` this repo; the skill comes with it (Cortex Code auto-discovers
   skills under `.cortex/skills/`). To install standalone, copy that folder to
   `~/.snowflake/cortex/plugins/gragen-accelerator/`.
2. **Share it (optional)** — run `/share-skill` in Cortex Code to publish it as a Cortex
   Extension to other users in the account; they install it via `/find-skill`.
3. **Prereqs** — `snow` CLI connection (ACCOUNTADMIN) to your own Snowflake account, Docker
   `buildx`, and AWS CLI authenticated against the shared AWS account (permission to create an
   S3 bucket + IAM user/role). Self-contained — no other project required.
4. **Run it** — fill in `config.env` (just prefix/bucket/region), then ask Cortex Code to
   *"deploy the GRAGEN accelerator"*; the skill loads and walks Steps 0–9 (config → AWS
   provision → setup → IAM trust → images → services → seed variants/ClinVar → external
   functions + `GENOMICS_AGENT` + tools → annotation/pedigree tables → verify). Condensed:

   ```bash
   cp config.env.example config.env         # edit DEPLOY_PREFIX, S3_BUCKET, AWS_REGION, GRAGEN_CONNECTION
   bash provision_aws.sh                    # shared bucket + prefixed IAM user/role; fills creds in config.env
   bash setup.sh                            # creates volume + secrets, prints IAM trust info
   bash provision_aws.sh --trust            # set role trust from the volume DESC
   snow spcs image-registry login -c "$GRAGEN_CONNECTION"
   bash deploy.sh
   snow sql -f sql/02_external_functions.sql -c "$GRAGEN_CONNECTION"
   snow sql -f sql/04_annotation_tables.sql -c "$GRAGEN_CONNECTION"
   python3 app/build_clinvar_iceberg.py     # + PUT/COPY INTO CHR22_CLINVAR
   python3 app/build_gwas_iceberg.py        # + PUT/COPY INTO CHR22_GWAS
   snow sql -f app/build_sfari_iceberg.sql  -c "$GRAGEN_CONNECTION"
   python3 app/build_pedigree_iceberg.py && snow sql -f app/build_pedigree_iceberg.sql -c "$GRAGEN_CONNECTION"
   python3 app/build_sample_metrics.py      # + PUT/COPY INTO SAMPLE_METRICS (Cohort QC + Origins)
   ```
5. **Re-apply grants** after any service/agent recreate (the skill's Critical Rules cover
   this): endpoint grants → `PUBLIC`; `SELECT` on Iceberg tables → `PUBLIC`/`GRAGEN_DB`;
   `USAGE` on the agent + tool procedures → `GRAGEN_DB`, `SYSADMIN`.

---

## Documentation

- **`.cortex/skills/gragen-accelerator/SKILL.md`** — the authoritative, step-by-step
  deployment + rebuild playbook (IceChunk schema, EAIs, seeding, annotation + pedigree
  tables, agent tools, critical rules, troubleshooting, version history).
- **`AGENT.md`** — how to operate/reproduce this project with Cortex Code, including
  connection details and the known gotchas.

---

## Data sources

- **1000 Genomes DRAGEN** — `s3://1000genomes-dragen` (public, no credentials)
- **ClinVar** — NCBI VCF (clinical significance, disease, gene)
- **GWAS Catalog** — EBI REST API (trait associations)
- **SFARI Gene** — curated autism gene list (hg38 coordinates)
- **1000G trio pedigree** — EBI `1kGP.3202_samples.pedigree_info.txt` (father/mother links)
