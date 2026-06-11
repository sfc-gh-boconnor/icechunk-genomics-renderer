# GRAGEN Genomics Accelerator — App Reference

## Live App

**FSI Builders Workshop URL:** `https://ertf2ob-sfsehol-fsi-builders-workshop-london-ifajaj.snowflakecomputing.app`  
**Auth:** Snowflake OAuth login (Snowsight credentials)  
**Account:** `SFSEHOL-FSI_BUILDERS_WORKSHOP_LONDON_IFAJAJ` · Connection: `fsi-builders-london` · Role: `GRAGEN_DB_ROLE`

**Internal Marketplace URL (reference deploy):** `https://j4a42cpb-sfsehol-internal-marketplace.snowflakecomputing.app`  
**Account:** `SFSEHOL-INTERNAL_MARKETPLACE` · Connection: `internal-marketplace`

> **Fresh deploy URL:** The SPCS ingress URL changes after every `ALTER SERVICE FROM SPECIFICATION`.
> Get the current URL with:
> ```sql
> SHOW ENDPOINTS IN SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE;
> -- → ingress_url column
> ```

---

## UI Layout

The app is a single-page dark-themed genomics workbench with a left sidebar (navigation + controls)
and a main content area that changes by view. Colour palette: `#0D1117` (bg), `#161B22` (surface),
`#1E2A3A` (surface-2), `#2D3F53` (border), `#29B5E8` (accent).

### Left Sidebar Views

| Nav item | Component | What it shows |
|----------|-----------|---------------|
| 🧬 **Genome Browser** | `GenomicsViewer.tsx` | Main view: chromosome selector, position input, 3D DNA helix, Gosling track, annotation controls, chat panel |
| 📊 **Cohort QC** | `CohortQC.tsx` | Scatter plot of 2,504 samples by sequencing QC metrics (Ti/Tv, coverage, het/hom ratio), grouped by population/sex |
| 🌍 **Origins** | `CohortGlobe.tsx` | 3D Blue-Marble Earth globe with sample points plotted at each population's geographic origin |
| 👪 **Families** | `FamilyConstellation.tsx` | Phyllotaxis galaxy of all 602 parent-offspring trios; layout modes: Spiral / By ancestry (5 superpopulations) / By population (26 1000G groups) / Globe |
| 🗂 **Data** | `DataManagementPanel.tsx` | Per-chromosome Zarr load status + ⬇ Seed button (launches async ingest job on `GRAGEN_INGEST_POOL`) |

---

## Genome Browser (main view)

### Controls (top bar)
- **Chromosome selector** — chr1–chr22 + chrX dropdown
- **Position** — start/end fields; zoom buttons; "Jump to gene" search (queries `AUTISM_GENES`)
- **Sample selector** — pick any of the 3,202 1000G samples; shows sample ID, population, sex
- **Father / Mother buttons** — switches the active sample to a parent (from `SAMPLE_PEDIGREE` trio)

### 3D DNA Helix (centre, `DNAHelix.tsx`)
- Double helix rendered with Three.js/react-three-fiber
- **Variant frequency** encoded as colour intensity along the backbone
- **Annotation markers** sit on stalks off the backbone:
  - Icosahedron = ClinVar (colour = clinical significance)
  - Octahedron = GWAS Catalog trait
  - Box/cube = SFARI autism gene
- **Hover** a marker → camera flies in, annotation card appears (disease/gene/trait/significance)
- **Click** a marker → sends context to the chat panel
- **Annotation source dropdown** (top-right): ClinVar / GWAS / SFARI / None
- **ClinVar filter** (when ClinVar active): Pathogenic only / Likely path+ / VUS+ / All

### Gosling Track (below helix)
- Genome browser track rendered by `gosling.js`
- Shows allele frequency as a bar chart over the current region
- Scrolls/zooms with the helix

### Chat Panel (right sidebar)
- Connects to `GENOMICS_AGENT` (Cortex Agent) via SSE streaming
- Understands genomic intent: chromosome/region jumps, gene lookups, filter changes, sample queries
- Agent tools: cohort stats, sample QC, outlier detection, annotation queries, pedigree, cohort variant AF

---

## Cohort QC

- Source: `GRAGEN_DB.GRAGEN.SAMPLE_METRICS` (~2,504 rows)
- X/Y axis: any two QC metrics (coverage, Ti/Tv, het/hom ratio, variant count, dup rate, etc.)
- Colour: superpopulation (AFR/AMR/EAS/EUR/SAS) or sex
- Hover → sample card with all QC values
- Click → opens that sample in Genome Browser

---

## Origins Globe

- Source: `GRAGEN_DB.GRAGEN.SAMPLE_METRICS` (population + superpopulation)
- 3D Blue-Marble Earth sphere (react-three-fiber)
- Each sample dot placed at its population's real geographic coordinates
- Colour = superpopulation
- Rotate/zoom with mouse

---

## Family Constellation

- Source: `GRAGEN_DB.GRAGEN.SAMPLE_PEDIGREE` ⋈ `SAMPLE_METRICS`
- 602 parent-offspring trios
- **Spiral** — phyllotaxis decoration
- **By ancestry** — 5 superpopulation islands on a ring
- **By population** — 26 clusters ordered by superpopulation (colour arcs)
- **Globe** — each family placed at its population's geographic origin on a 3D sphere
- Hover → family card (father + mother + child + sex + population)
- Click any node → opens that sample in Genome Browser
- Superpopulation legend = filter (click to show/hide that group)

---

## Data Management Panel

- Lists all chromosomes (chr1–chr22, chrX) with Zarr load status from `/api/meta`
- **⬇ Seed** button → calls `CALL GRAGEN_DB.GRAGEN.SEED_CHROMOSOME('chrN')` → launches async ingest job
- **↻ Refresh** → re-polls `/api/meta`
- **Time estimates:** chr22 ~25 min · chr21 ~20 min · chr1 ~90 min (all 3,201 samples, 16 workers)

---

## Backend API Endpoints (`gragen-service`, port 8080)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check; returns `{"status":"ok"}` |
| GET | `/meta` | IceChunk store info: chromosomes in store, n_variants, snapshots |
| GET | `/meta/clinvar` | ClinVar store info |
| POST | `/slice` | Variant slice (Snowflake service function format; 20 MB limit) |
| POST | `/clinvar_slice` | ClinVar slice (service function format) |
| POST | `/direct/variants` | Full-resolution variant slice (no size limit; used by helix) |
| POST | `/direct/clinvar` | Full-resolution ClinVar slice |
| POST | `/direct/seed_genomics` | Trigger VCF → IceChunk ingest `{"chroms":["chr22"],"max_workers":16}` |
| POST | `/direct/seed_clinvar` | Trigger ClinVar → IceChunk ingest `{"chroms":["chr22"]}` |

## Frontend Proxy Endpoints (`gragen-accelerator`, port 3001)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/meta` | Proxied to backend `/meta` |
| POST | `/api/direct/variants` | Proxied to backend `/direct/variants` |
| POST | `/api/direct/clinvar` | Proxied to backend `/direct/clinvar` |
| POST | `/api/direct/seed_genomics` | Trigger ingest (also via UI) |
| POST | `/api/query` | Runs arbitrary SQL against Snowflake (annotations, QC, pedigree) |
| POST | `/api/save-variants` | Saves a variant slice to a Snowflake table via SQL |
| POST | `/api/agent/chat` | Streams GENOMICS_AGENT response via SSE |

---

## Cortex Agent Tools

| Tool | What it answers |
|------|----------------|
| `tool_cohort_query` | QC stats grouped by superpopulation |
| `tool_sample_meta` | Full QC metrics for one sample |
| `tool_find_outliers` | Top/bottom samples by any metric |
| `tool_query_annotations` | ClinVar/GWAS/SFARI annotations by region, gene, or summary |
| `tool_pedigree` | Trio father/mother/children for a sample |
| `tool_cohort_variants` | Cohort allele frequency joined to ClinVar/GWAS for a gene/region |

---

## Key Snowflake Objects

```
GRAGEN_DB.GRAGEN
├── GRAGEN_SERVICE                       SPCS backend (port 8080)
├── GRAGEN_ACCELERATOR_SERVICE           SPCS frontend (port 3001, public ingress)
├── GRAGEN_INGEST_POOL                   CPU_X64_L, 16 vCPU — async chromosome ingest
├── GRAGEN_COMPUTE_POOL                  CPU_X64_S — app services
├── GRAGEN_WH                            Warehouse for SQL queries + Iceberg loads
├── GRAGEN_LOAD_STAGE                    Internal stage for CSV → Iceberg loads
├── GRAGEN_REPO                          Image repository
│
├── GENOMICS_ICEBERG_VOLUME              External volume → s3://<bucket>/<prefix>/iceberg/
│
├── GRAGEN_SLICE(CHROM, START, END)      Service function → backend /slice
├── GRAGEN_CLINVAR_SLICE(CHROM,START,END) Service function → backend /clinvar_slice
├── SEED_CHROMOSOME(CHROM)               Stored proc → EXECUTE JOB SERVICE (async ingest)
├── GENOMICS_AGENT                       Cortex Agent
│
├── TOOL_COHORT_QUERY, TOOL_SAMPLE_META, TOOL_FIND_OUTLIERS
├── TOOL_QUERY_ANNOTATIONS, TOOL_PEDIGREE, TOOL_COHORT_VARIANTS
│
├── SAMPLE_METRICS                       ~2504 rows — cohort QC + population (native table)
├── CHR22_CLINVAR                        ~4.43M rows — ClinVar genome-wide (Iceberg)
├── CHR22_GWAS                           ~10-15K rows — GWAS Catalog (Iceberg)
├── AUTISM_GENES                         25 rows — SFARI autism genes (Iceberg)
├── SAMPLE_PEDIGREE                      3202 rows — 1000G trio pedigree (Iceberg)
└── GRAGEN_CONFIG                        1 row — bucket/prefix/region (read by SEED_CHROMOSOME)
```

---

## Data Sources

| Dataset | Source | Size |
|---------|--------|------|
| 1000 Genomes DRAGEN | `s3://1000genomes-dragen` (public) | 3,202 samples, chr22 = ~1.93M variants |
| ClinVar | NCBI FTP `clinvar.vcf.gz` (public HTTPS) | ~4.4M variants genome-wide |
| GWAS Catalog | EBI REST API | ~10-15K associations |
| SFARI autism genes | Curated list (hardcoded in `build_sfari_iceberg.sql`) | 25 genes |
| 1000G pedigree | `s3://1000genomes-dragen` metadata TSV | 3,202 samples / 602 trios |
| 1000G QC metrics | `s3://1000genomes-dragen` per-sample DRAGEN reports | 2,504 unrelated samples |
