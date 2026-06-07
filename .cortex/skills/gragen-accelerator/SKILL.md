---
name: gragen-accelerator
description: "Deploy the GRAGEN Genomics Accelerator on Snowflake Container Services (SPCS). Ingests 1000 Genomes DRAGEN VCF files from a public S3 bucket into an IceChunk Zarr store (same pattern as the weather/NetCDF project), then serves variant slice queries and cohort QC analytics via a FastAPI backend + React/DeckGL frontend. Use when: deploying GRAGEN accelerator, genomics IceChunk SPCS, 1000 Genomes DRAGEN visualisation, VCF to IceChunk pipeline, genomics Cortex Agent, variant browser Snowflake."
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
genomics_repo/           ← IceChunk store on S3 (icechunk-ro bucket, genomics_repo/ prefix)
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
IceChunk on S3:  s3://icechunk-ro/genomics_repo/   (SAME bucket as weather project)
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

- `snow` CLI authenticated: `snow connection test -c <CONNECTION>`
- Docker with `buildx`
- SYSADMIN + ACCOUNTADMIN on target Snowflake account
- **Weather IceChunk project already deployed** (reuses `icechunk-ro` S3 bucket +
  `ICECHUNK_AWS_KEY_ID` / `ICECHUNK_AWS_SECRET_KEY` Snowflake secrets)

---

## Parameters

| Parameter | Example |
|-----------|---------|
| `<CONNECTION>` | `internal-marketplace` |
| `<REGISTRY>` | `<account>.registry.snowflakecomputing.com/gragen_db/gragen/gragen_repo` |
| S3 bucket | `icechunk-ro` (shared with weather project, prefix `genomics_repo/`) |
| Public source | `s3://1000genomes-dragen` (no credentials needed) |

---

## Workflow

```
Step 0: Snowflake setup (DB, pool, EAIs, role/user — reuse S3 bucket/secrets)
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

### Step 0: Snowflake Setup

```bash
snow sql -f sql/01_setup.sql -c <CONNECTION>
```

**Key note**: Uses the same `icechunk-ro` S3 bucket and `ICECHUNK_AWS_KEY_ID` / 
`ICECHUNK_AWS_SECRET_KEY` secrets from the weather project. The genomics Zarr store 
writes to prefix `genomics_repo/` in the same bucket. No new IAM user or S3 bucket needed.

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
GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE ICECHUNK_DB;
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
4. Commits snapshot to `s3://icechunk-ro/clinvar_repo/`

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

```bash
# Seed all autosomes + X for 1000G:
curl -X POST https://<URL>/api/direct/seed_genomics \
  -d '{"chroms": ["chr1","chr2","chr3","chr4","chr5","chr6","chr7",
       "chr8","chr9","chr10","chr11","chr12","chr13","chr14","chr15",
       "chr16","chr17","chr18","chr19","chr20","chr21","chrX"]}'

# Seed all chromosomes for ClinVar (~30 min for full genome):
curl -X POST https://<URL>/api/direct/seed_clinvar \
  -d '{"chroms": ["chr1","chr2","chr3","chr4","chr5","chr6","chr7",
       "chr8","chr9","chr10","chr11","chr12","chr13","chr14","chr15",
       "chr16","chr17","chr18","chr19","chr20","chr21","chr22","chrX"]}'
```

---

## Critical Rules

1. **Both IceChunk stores must be seeded before queries work:**
   - `genomics_repo/` (1000G variants) → seed via `POST /api/direct/seed_genomics`
   - `clinvar_repo/` (ClinVar annotations) → seed via `POST /api/direct/seed_clinvar`
   - `/meta` and `/meta/clinvar` show which chromosomes are available.

2. **Reuses weather project's S3 bucket** — prefixes are `genomics_repo/` and `clinvar_repo/`. The `AWS_ACCESS_KEY_ID` secret must have write access to `icechunk-ro`.

3. **VCF ingestion uses pysam HTTPS range requests**:
   - 1000G: requires `GENOMICS_1000G_EAI` on `gragen-service`
   - ClinVar: requires `NCBI_FTP_EAI` on `gragen-service`
   - Without the EAI, ingest fails silently (pysam connection timeout)

4. **Position arrays are sorted** — slicing uses `np.searchsorted` O(log n), not a full scan.

5. **20 MB external function limit applies to `GRAGEN_SLICE` and `CLINVAR_SLICE`**. Large regions are auto-downsampled by stride. Use `/api/direct/variants` and `/api/direct/clinvar` for full resolution.

6. **GRANT SERVICE ROLE required after every ALTER SERVICE** — SPCS drops endpoint grants when the service spec is updated. Always re-run:
   ```sql
   GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC;
   GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE ICECHUNK_DB;
   ```

7. **chr22 first** — smallest autosome, validates the full pipeline in ~15 minutes total.

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
| v1.0.3 | 2026-06-07 | ClinVar overlay: IceChunk clinvar_repo/, /seed_clinvar, /direct/clinvar, CLINSIG overlay track in genome browser, CLINVAR_SLICE external function, NCBI_FTP_EAI |
| v1.0.2 | 2026-06-07 | CSP fix (remove Google Fonts), GENOMICS_1000G_EAI created, GRAGEN_DB role + endpoint grants |
| v1.0.1 | 2026-06-07 | Initial build: chr22 IceChunk store, cohort QC scatter, genome browser, GENOMICS_AGENT |

---

*This skill is updated after each deployment. Check version history for latest changes.*
