#!/usr/bin/env bash
# =============================================================================
# GRAGEN Genomics Accelerator — Deploy Script  v1.0.1
# =============================================================================
# Usage:
#   bash deploy.sh                        # build + deploy both services
#   bash deploy.sh --backend-only         # backend only
#   bash deploy.sh --accel-only           # frontend only
#   bash deploy.sh --build-only           # build + push images, no deploy
#   bash deploy.sh --service-version 1.0.2  --accel-version 1.0.2
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Preflight: verify prerequisites (Docker required for builds) ──────────────
# Set GRAGEN_SKIP_PREFLIGHT=1 to bypass.
if [[ "${GRAGEN_SKIP_PREFLIGHT:-0}" != "1" && -f "${SCRIPT_DIR}/preflight.sh" ]]; then
  bash "${SCRIPT_DIR}/preflight.sh" --no-aws || {
    echo "Preflight failed. Fix the items above, or set GRAGEN_SKIP_PREFLIGHT=1 to override." >&2
    exit 1
  }
fi

# ── Load deployment config (bucket / prefix / region) ─────────────────────────
if [[ -f "${SCRIPT_DIR}/config.env" ]]; then
  # shellcheck disable=SC1090
  source "${SCRIPT_DIR}/config.env"
else
  echo "ERROR: config.env not found. Copy config.env.example to config.env and edit it (run setup.sh first)." >&2
  exit 1
fi

CONNECTION="${GRAGEN_CONNECTION:-internal-marketplace}"
S3_BUCKET="${S3_BUCKET:?set in config.env}"
DEPLOY_PREFIX="${DEPLOY_PREFIX:?set in config.env}"
AWS_REGION="${AWS_REGION:-us-west-2}"
CURRENT_VERSION=$(cat "${SCRIPT_DIR}/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "latest")

# ── Parse flags ───────────────────────────────────────────────────────────────
DEPLOY_BACKEND=true
DEPLOY_ACCEL=true
BUILD_ONLY=false
SERVICE_VERSION=""
ACCEL_VERSION=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --backend-only)   DEPLOY_ACCEL=false;   shift ;;
    --accel-only)     DEPLOY_BACKEND=false; shift ;;
    --build-only)     BUILD_ONLY=true;      shift ;;
    --service-version) SERVICE_VERSION="$2"; shift 2 ;;
    --accel-version)  ACCEL_VERSION="$2";  shift 2 ;;
    --version)        SERVICE_VERSION="$2"; ACCEL_VERSION="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

[[ -z "$SERVICE_VERSION" ]] && SERVICE_VERSION="$CURRENT_VERSION"
[[ -z "$ACCEL_VERSION"   ]] && ACCEL_VERSION="$CURRENT_VERSION"

# ── Snowflake account details ─────────────────────────────────────────────────
ACCOUNT=$(python3 -c "
import re, os
path = os.path.expanduser('~/.snowflake/connections.toml')
with open(path) as f: txt = f.read()
conn = '${CONNECTION}'.replace('-', '_').lower()
# Try both dashes and underscores in section name
for name in ['${CONNECTION}', conn]:
    m = re.search(r'\[' + re.escape(name) + r'\][^\[]*account\s*=\s*[\"\'](.*?)[\"\']', txt, re.DOTALL | re.IGNORECASE)
    if m:
        print(m.group(1).lower().replace('_', '-'))
        exit(0)
print('')
" 2>/dev/null || echo "")
DB="gragen_db"
SCHEMA="gragen"
REGISTRY="${ACCOUNT}.registry.snowflakecomputing.com/${DB}/${SCHEMA}/gragen_repo"

echo "=== GRAGEN Deploy ==="
echo "  Connection: $CONNECTION"
echo "  Registry:   $REGISTRY"
$DEPLOY_BACKEND && echo "  Backend:    gragen-service:${SERVICE_VERSION}"
$DEPLOY_ACCEL   && echo "  Frontend:   gragen-accelerator:${ACCEL_VERSION}"
echo ""

# ── Authenticate to registry ──────────────────────────────────────────────────
echo ">>> Authenticating to Snowflake registry…"
snow spcs image-registry login -c "$CONNECTION"

# ── Build + push backend ──────────────────────────────────────────────────────
if $DEPLOY_BACKEND; then
  echo ">>> Building gragen-service:${SERVICE_VERSION}…"
  docker buildx build --platform linux/amd64 \
    -t "${REGISTRY}/gragen-service:${SERVICE_VERSION}" --push \
    -f "${SCRIPT_DIR}/Dockerfile" "${SCRIPT_DIR}/"
  echo ">>> gragen-service image pushed."
fi

# ── Build + push frontend ─────────────────────────────────────────────────────
if $DEPLOY_ACCEL; then
  echo ">>> Building gragen-accelerator:${ACCEL_VERSION}…"
  docker buildx build --platform linux/amd64 \
    -t "${REGISTRY}/gragen-accelerator:${ACCEL_VERSION}" --push \
    -f "${SCRIPT_DIR}/gragen-accelerator/Dockerfile" "${SCRIPT_DIR}/gragen-accelerator/"
  echo ">>> gragen-accelerator image pushed."
fi

if $BUILD_ONLY; then
  echo "=== Build complete (--build-only, skipping deploy) ==="
  exit 0
fi

# ── Deploy backend ────────────────────────────────────────────────────────────
if $DEPLOY_BACKEND; then
  echo ">>> Deploying gragen-service:${SERVICE_VERSION}…"
  read -r -d '' BACKEND_SPEC <<EOF || true
spec:
  containers:
  - name: gragen-service
    image: /${DB}/${SCHEMA}/gragen_repo/gragen-service:${SERVICE_VERSION}
    env:
      PYTHONUNBUFFERED:           "1"
      ICECHUNK_BUCKET:            "${S3_BUCKET}"
      ICECHUNK_GENOMICS_PREFIX:   "${DEPLOY_PREFIX}/genomics_repo"
      ICECHUNK_CLINVAR_PREFIX:    "${DEPLOY_PREFIX}/clinvar_repo"
      AWS_DEFAULT_REGION:         "${AWS_REGION}"
      INGEST_WORKERS:             "16"
    secrets:
    - snowflakeSecret:
        objectName: GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID
      envVarName: AWS_ACCESS_KEY_ID
    - snowflakeSecret:
        objectName: GRAGEN_DB.GRAGEN.AWS_SECRET_ACCESS_KEY
      envVarName: AWS_SECRET_ACCESS_KEY
    readinessProbe:
      port: 8080
      path: /health
  endpoints:
  - name: api-endpoint
    port: 8080
    public: false
EOF
  # First run: create the service (no-op if it already exists). Redeploys: ALTER updates the spec.
  snow sql -c "$CONNECTION" -q "CREATE SERVICE IF NOT EXISTS GRAGEN_DB.GRAGEN.GRAGEN_SERVICE
  IN COMPUTE POOL GRAGEN_COMPUTE_POOL
  FROM SPECIFICATION \$\$
${BACKEND_SPEC}
\$\$
  EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI)
  MIN_INSTANCES = 1 MAX_INSTANCES = 2;"
  snow sql -c "$CONNECTION" -q "ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE FROM SPECIFICATION \$\$
${BACKEND_SPEC}
\$\$"
  echo ">>> Re-applying backend EAI…"
  snow sql -c "$CONNECTION" -q "ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, GENOMICS_1000G_EAI);"
  echo ">>> Backend deployed."
fi

# ── Deploy frontend ───────────────────────────────────────────────────────────
if $DEPLOY_ACCEL; then
  echo ">>> Deploying gragen-accelerator:${ACCEL_VERSION}…"
  read -r -d '' ACCEL_SPEC <<EOF || true
spec:
  containers:
  - name: gragen-accelerator
    image: /${DB}/${SCHEMA}/gragen_repo/gragen-accelerator:${ACCEL_VERSION}
    env:
      GRAGEN_SERVICE_URL: http://gragen-service:8080
      SNOWFLAKE_WAREHOUSE: GRAGEN_WH
    readinessProbe:
      port: 3001
      path: /healthz
  endpoints:
  - name: http-endpoint
    port: 3001
    public: true
EOF
  snow sql -c "$CONNECTION" -q "CREATE SERVICE IF NOT EXISTS GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE
  IN COMPUTE POOL GRAGEN_COMPUTE_POOL
  FROM SPECIFICATION \$\$
${ACCEL_SPEC}
\$\$
  EXTERNAL_ACCESS_INTEGRATIONS = (GRAGEN_MAP_TILES_EAI)
  MIN_INSTANCES = 1 MAX_INSTANCES = 1;"
  snow sql -c "$CONNECTION" -q "ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE FROM SPECIFICATION \$\$
${ACCEL_SPEC}
\$\$"
  echo ">>> Re-applying frontend EAIs…"
  snow sql -c "$CONNECTION" -q "ALTER SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (GRAGEN_MAP_TILES_EAI);"
  echo ">>> Re-applying frontend endpoint grants…"
  snow sql -c "$CONNECTION" -q "GRANT SERVICE ROLE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE PUBLIC;" || true
  echo ">>> Frontend deployed."
fi

# ── Print live URL ────────────────────────────────────────────────────────────
echo ""
echo ">>> Fetching live app URL…"
APP_URL=$(snow sql -c "$CONNECTION" -q "SHOW ENDPOINTS IN SERVICE GRAGEN_DB.GRAGEN.GRAGEN_ACCELERATOR_SERVICE;" --format json 2>/dev/null \
  | python3 -c "import sys,json; rows=json.load(sys.stdin); url=[r.get('ingress_url','') for r in rows if r.get('ingress_url','')]; print(url[0] if url else '')" 2>/dev/null || echo "")

if [[ -n "$APP_URL" ]]; then
  echo ""
  echo "┌──────────────────────────────────────────────────────────────────────┐"
  echo "│  App URL: https://${APP_URL}"
  echo "└──────────────────────────────────────────────────────────────────────┘"
fi

echo ""
echo "=== Deploy complete ==="
