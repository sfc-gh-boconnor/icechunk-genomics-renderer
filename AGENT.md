# AGENT.md — Operating GRAGEN with Cortex Code

Operational guide for Cortex Code (CoCo) to reproduce, deploy, and debug the GRAGEN
Genomics Accelerator. Human overview is in `README.md`; the full step-by-step playbook
is in `.cortex/skills/gragen-accelerator/SKILL.md` (the `gragen-accelerator` skill).

---

## Snowflake connection

| Item | Value |
|------|-------|
| Connection name | `internal-marketplace` (always pass `--warehouse GRAGEN_WH` with `snow sql`) |
| Account | `SFSEHOL-INTERNAL_MARKETPLACE` |
| Role | `ACCOUNTADMIN` (grants/users), `GRAGEN_DB_ROLE` (app role) |
| Database / schema | `GRAGEN_DB.GRAGEN` |
| Warehouse | `GRAGEN_WH` |
| Compute pool | `GRAGEN_COMPUTE_POOL` (CPU_X64_S, MIN 1 MAX 2) |
| Registry | `sfsehol-internal-marketplace.registry.snowflakecomputing.com/gragen_db/gragen/gragen_repo` |
| App URL | https://j4a42cpb-sfsehol-internal-marketplace.snowflakecomputing.app (OAuth login) |

Services: `GRAGEN_DB.GRAGEN.GRAGEN_SERVICE` (backend, 8080) ·
`GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE` (frontend, 3001, public).

---

## Storage model (do not violate)

- **Bring your own bucket + unique prefix.** All storage is namespaced under a deployer-chosen
  `DEPLOY_PREFIX` (in `config.env`) inside the deployer's own S3 bucket. `setup.sh` renders the
  SQL templates and creates `GENOMICS_ICEBERG_VOLUME` pointed at
  `s3://<bucket>/<prefix>/iceberg/`. Never hardcode a bucket name in code.
- **Cohort variant / sample data → IceChunk Zarr only** (`s3://<bucket>/<prefix>/genomics_repo/`).
  Never materialise to a Snowflake table — too large.
- **Annotations → Snowflake Iceberg** (`EXTERNAL_VOLUME='GENOMICS_ICEBERG_VOLUME'
  ICEBERG_VERSION=2 CATALOG='SNOWFLAKE'`, relative `BASE_LOCATION`s under the volume base).
  The frontend queries these via `/api/query`, so **adding/refreshing an annotation source
  needs no backend rebuild.** External volumes authenticate via an **IAM role**
  (`ICEBERG_ROLE_ARN`), not access keys.

### Iceberg annotation tables (genome-wide despite `CHR22_` prefix)

| Table | Builder | Key columns |
|-------|---------|-------------|
| `CHR22_CLINVAR` (~4.43M) | DDL `sql/04_annotation_tables.sql` + `app/build_clinvar_iceberg.py` | `CHROM, POSITION, CLINSIG, REVSTAT, ALLELE_ID, REF_LEN, ALT_LEN, DISEASE, GENE` |
| `CHR22_GWAS` | DDL `sql/04_annotation_tables.sql` + `app/build_gwas_iceberg.py` | `CHROM, POSITION, TRAIT, MAPPED_GENE, RSID, RISK_ALLELE, P_VALUE` |
| `AUTISM_GENES` (25) | `app/build_sfari_iceberg.sql` | `GENE, CHROM, START_POS, END_POS, SFARI_SCORE, NOTE` |
| `SAMPLE_PEDIGREE` (3202) | `app/build_pedigree_iceberg.py` + `.sql` | `SAMPLE_ID, FATHER_ID, MOTHER_ID, SEX, RELATIONSHIP` — 1000G trio pedigree (father/mother links; 608 children) |

`CLINSIG`: `0=Benign 1=Likely benign 2=VUS 3=Likely pathogenic 4=Pathogenic 5=Conflicting 6=Other`.
Load stage: `@GRAGEN_DB.GRAGEN.GRAGEN_LOAD_STAGE`.
Load = `PUT file://… OVERWRITE=TRUE AUTO_COMPRESS=TRUE` → `COPY INTO …
FILE_FORMAT=(TYPE=CSV SKIP_HEADER=1 FIELD_OPTIONALLY_ENCLOSED_BY='"' EMPTY_FIELD_AS_NULL=TRUE)`.

---

## Common commands

```bash
# Deploy (ALWAYS bump version in VERSION or pass explicit version)
bash deploy.sh --accel-only   --accel-version X.Y.Z      # frontend (~4 min)
bash deploy.sh --backend-only --service-version X.Y.Z    # backend
bash deploy.sh --build-only                              # build+push images, no deploy

# Service status / endpoints
snow sql -c internal-marketplace --warehouse GRAGEN_WH \
  -q "SELECT SYSTEM\$GET_SERVICE_STATUS('GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE')"
snow sql -c internal-marketplace --warehouse GRAGEN_WH \
  -q "SHOW ENDPOINTS IN SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE"

# Seed variants into Zarr (per-chromosome commit; smallest-first)
curl -X POST https://<URL>/api/direct/seed_genomics -d '{"chroms":["chr21","chr20",...]}'

# Refresh an annotation table (re-runnable)
python3 app/build_clinvar_iceberg.py    # ClinVar VCF → /tmp/clinvar_all.csv
python3 app/build_gwas_iceberg.py       # EBI GWAS → /tmp/gwas_all.csv
```

---

## Critical gotchas (learned the hard way)

1. **`ALTER SERVICE … FROM SPECIFICATION` replaces the WHOLE spec.** Any omitted
   `env:` / `secrets:` block is dropped. The `gragen-service` spec MUST always include
   the ICECHUNK env vars **and** the AWS secrets, or S3 access breaks (503 / repo not found).
   `deploy.sh` (sources `config.env`) and `sql/03_deploy_services.sql.tmpl` are the source of
   truth — keep them complete.

2. **AWS secrets are self-contained: `GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID` /
   `AWS_SECRET_ACCESS_KEY`** (created by `setup.sh`; NO `ICECHUNK_DB`, NO `ICECHUNK_` prefix).
   Wrong names fail with "Secret … does not exist or not authorized" and the ALTER silently
   leaves the old spec.

3. **Re-apply EAIs after every backend `ALTER SERVICE`:**
   `SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI)`.
   Frontend needs `GRAGEN_MAP_TILES_EAI`. ClinVar ingest needs `NCBI_FTP_EAI`.

4. **Re-apply endpoint grants after every frontend `ALTER SERVICE`** (SPCS drops them):
   `GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC;`

5. **Always bump `VERSION`** (or pass `--*-version`) so SPCS pulls the new image.

6. **Frontend pins:** React 18.3.1, `@react-three/fiber@8`, `@react-three/drei@9`,
   `three@0.184`, `pixi.js ~6.5.10` (gosling.js@1.0.7 needs pixi ^6 — v8 removed
   `utils.rgb2hex`). Do not bump these without testing the helix + Gosling tracks.

7. **`GRAGEN_WH` must be granted to `GRAGEN_DB_ROLE`** (USAGE) and set as the service
   warehouse env (`SNOWFLAKE_WAREHOUSE: GRAGEN_WH`) or `/api/query` returns 422.

8. **VCF ingest uses boto3/urllib HTTP range requests via the TBI index**, NOT pysam —
   pysam/libcurl does not route through the SPCS EAI proxy and hangs silently.

9. Harmless deploy noise: `GRAGEN_MAP_TILES_EAI` / `GRAGEN_FONTS_EAI` re-apply errors
   for EAIs that don't exist — ignore.

10. **`CREATE OR REPLACE AGENT` drops ALL grants on the agent.** After recreating
   `GENOMICS_AGENT`, re-grant `USAGE ON AGENT … TO ROLE GRAGEN_DB, GRAGEN_DB_ROLE, SYSADMIN`
   or the frontend gets `Cortex Agent API 401: agent does not exist or access is not
   authorized`. Also re-grant `USAGE` on every tool procedure to those roles.

11. **New Iceberg tables are not readable until granted.** A freshly `CREATE`d table
   (e.g. annotation tables) returns "does not exist or not authorized" from the frontend
   `/api/query` until you `GRANT SELECT … TO ROLE PUBLIC` (and `GRAGEN_DB_ROLE`). A
   `GRANT SELECT ON FUTURE TABLES IN SCHEMA GRAGEN_DB.GRAGEN TO ROLE PUBLIC` covers new ones.

12. **Origins globe uses react-three-fiber** (not deck.gl `_GlobeView`, which is experimental
   and renders blank). Earth texture is bundled at `gragen-accelerator/public/earth-blue-marble.jpg`
   (served at `/earth-blue-marble.jpg`). The r3f `<Canvas>` needs an explicit container height
   (`height:100%` + `minHeight`) or it collapses.

13. **Genome browser fetches variants via SQL service functions, not `/api/direct`.**
   `gragen-accelerator/server/index.ts` calls `GRAGEN_SLICE(CHROM,START,END)` and
   `GRAGEN_CLINVAR_SLICE(CHROM,START,END)` (3 args, **no sample_id**). These are SPCS
   **service functions** bound to `GRAGEN_SERVICE` (`CREATE FUNCTION … SERVICE=GRAGEN_SERVICE
   ENDPOINT='api-endpoint' AS '/slice'`), created in `sql/02_external_functions.sql` — which
   must run **after** `deploy.sh` (the service must exist). Symptom if missing/disabled:
   "Unknown user-defined function GRAGEN_DB.GRAGEN.GRAGEN_SLICE" on Fetch Variants.

14. **Restart the backend after an out-of-container ingest.** The backend caches its IceChunk
   repo handle (`_repo`). An `EXECUTE JOB SERVICE` ingest commits new snapshots the backend's
   cached handle won't see, so the genome browser stays empty even though the store has data.
   Fix: `ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE SUSPEND;` then `RESUME;`. (In-container
   `/seed_genomics` self-invalidates the cache; external jobs do not.)

---

## Frontend annotation/chat wiring

- `gragen-accelerator/src/types.ts` — `GenomeAnnotation`, `AnnoSource = 'clinvar'|'gwas'|'sfari'`, colour maps.
- `gragen-accelerator/src/components/DNAHelix.tsx` — `AnnoMarker` (source-specific shape), source dropdown +
  ClinVar significance filter, `CameraRig` hover-zoom, generalized annotation card.
- `gragen-accelerator/src/components/GenomicsViewer.tsx` — `loadAnnotations()` queries the Iceberg table for
  the current source/region via `/api/query`; `applyChatIntent()` parses chat to drive
  source/filter, chromosome/region jump, gene jump (`AUTISM_GENES`), and sample-by-sex switch.

---

## Reproduce from scratch

Follow `.cortex/skills/gragen-accelerator/SKILL.md` Steps 0–9 in order. chr22 first
(smallest autosome) validates the full pipeline in ~15 min before going genome-wide.
