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
┌─ IceChunk Zarr on S3 (s3://icechunk-ro/genomics_repo/, clinvar_repo/) ─ cohort variants (huge, numeric)
└─ Snowflake Iceberg (GENOMICS_ICEBERG_VOLUME) ───────────────────────── annotations (small, categorical)
```

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
├── sql/                      01_setup, 02_external_functions, 03_deploy_services
├── Dockerfile · deploy.sh · VERSION · GENOMICS_SV.yaml
├── AGENT.md                  Operational guide for Cortex Code (CoCo)
└── .cortex/skills/gragen-accelerator/SKILL.md   Full step-by-step deployment playbook
```

---

## Quick start

> Prerequisites: `snow` CLI authenticated, Docker with `buildx`, the weather IceChunk
> project already deployed (reuses the `icechunk-ro` S3 bucket + AWS secrets in
> `ICECHUNK_DB.ICECHUNK`). Full detail is in the skill.

```bash
# 1. Snowflake setup (DB, compute pool, EAIs, role/user)
snow sql -f sql/01_setup.sql -c internal-marketplace

# 2. Build + push images, deploy both SPCS services
snow spcs image-registry login -c internal-marketplace
bash deploy.sh                       # prints the live app URL

# 3. Seed chr22 variants + ClinVar into IceChunk (via the app, see SKILL.md Step 3–4)
# 4. External functions + Cortex Agent
snow sql -f sql/02_external_functions.sql -c internal-marketplace

# 5. Load genome-wide annotation tables (Iceberg)
python3 app/build_clinvar_iceberg.py    # then COPY INTO CHR22_CLINVAR
python3 app/build_gwas_iceberg.py       # then COPY INTO CHR22_GWAS
snow sql -f app/build_sfari_iceberg.sql -c internal-marketplace
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
3. **Prereqs** — `snow` CLI connection (`internal-marketplace`), Docker `buildx`, and the
   weather IceChunk project deployed (reuses the `icechunk-ro` bucket + AWS secrets).
4. **Run it** — ask Cortex Code to *"deploy the GRAGEN accelerator"*; the skill loads and
   walks Steps 0–9 (setup → images → services → seed variants/ClinVar → external functions +
   `GENOMICS_AGENT` + tools → annotation/pedigree tables → verify). Condensed:

   ```bash
   snow sql -f sql/01_setup.sql -c internal-marketplace
   snow spcs image-registry login -c internal-marketplace
   bash deploy.sh
   snow sql -f sql/02_external_functions.sql -c internal-marketplace
   python3 app/build_clinvar_iceberg.py     # + COPY INTO CHR22_CLINVAR
   python3 app/build_gwas_iceberg.py        # + COPY INTO CHR22_GWAS
   snow sql -f app/build_sfari_iceberg.sql  -c internal-marketplace
   python3 app/build_pedigree_iceberg.py && snow sql -f app/build_pedigree_iceberg.sql -c internal-marketplace
   ```
5. **Re-apply grants** after any service/agent recreate (the skill's Critical Rules cover
   this): endpoint grants → `PUBLIC`; `SELECT` on Iceberg tables → `PUBLIC`/`GRAGEN_DB_ROLE`;
   `USAGE` on the agent + tool procedures → `GRAGEN_DB`, `GRAGEN_DB_ROLE`, `SYSADMIN`, `ICECHUNK_DB`.

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
