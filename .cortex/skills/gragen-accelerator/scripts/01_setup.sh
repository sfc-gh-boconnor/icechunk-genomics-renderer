#!/usr/bin/env bash
# =============================================================================
# GRAGEN Genomics Accelerator — one-time Snowflake setup  v1.0.0
# =============================================================================
# Reads config.env, then:
#   1. validates DEPLOY_PREFIX
#   2. renders the parameterized SQL templates (envsubst, $$ preserved)
#   3. creates the AWS secrets in GRAGEN_DB.GRAGEN (inline, never written to disk)
#   4. runs 01_setup.sql (db/wh/pool/EAIs + GENOMICS_ICEBERG_VOLUME)
#   5. prints the IAM trust-policy details you must add before loading data
#
# Usage:
#   cp config.env.example config.env   # then edit
#   bash setup.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Preflight: verify prerequisites first ─────────────────────────────────────
# setup.sh creates Snowflake objects but does not build images, so Docker is
# not strictly required here. Set GRAGEN_SKIP_PREFLIGHT=1 to bypass.
if [[ "${GRAGEN_SKIP_PREFLIGHT:-0}" != "1" && -f "${SCRIPT_DIR}/preflight.sh" ]]; then
  bash "${SCRIPT_DIR}/preflight.sh" --no-docker --no-aws || {
    echo "Preflight failed. Fix the items above, or set GRAGEN_SKIP_PREFLIGHT=1 to override." >&2
    exit 1
  }
fi

# ── Load config ───────────────────────────────────────────────────────────────
if [[ ! -f "${SCRIPT_DIR}/config.env" ]]; then
  echo "ERROR: config.env not found. Copy config.env.example to config.env and edit it." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "${SCRIPT_DIR}/config.env"

: "${GRAGEN_CONNECTION:?set in config.env}"
: "${DEPLOY_PREFIX:?set in config.env}"
: "${S3_BUCKET:?set in config.env}"
: "${AWS_REGION:?set in config.env}"
: "${AWS_ACCESS_KEY_ID:?set in config.env}"
: "${AWS_SECRET_ACCESS_KEY:?set in config.env}"
: "${ICEBERG_ROLE_ARN:?set in config.env}"

# ── Validate prefix ───────────────────────────────────────────────────────────
if [[ ! "$DEPLOY_PREFIX" =~ ^[a-z0-9_]+$ ]]; then
  echo "ERROR: DEPLOY_PREFIX must be lowercase letters, digits and underscores only (^[a-z0-9_]+\$). Got: '$DEPLOY_PREFIX'" >&2
  exit 1
fi

echo "=== GRAGEN Setup ==="
echo "  Connection:   $GRAGEN_CONNECTION"
echo "  Prefix:       $DEPLOY_PREFIX"
echo "  Bucket:       s3://$S3_BUCKET/$DEPLOY_PREFIX/  ($AWS_REGION)"
echo "  Iceberg role: $ICEBERG_ROLE_ARN"
echo ""

# ── Render SQL templates ──────────────────────────────────────────────────────
# Replace only our 4 explicit placeholders (via python3, always present on macOS)
# so SQL dollar-quoting ($$) and any other $tokens are left untouched.
RENDER_DIR="${SCRIPT_DIR}/sql/_rendered"
mkdir -p "$RENDER_DIR"
export S3_BUCKET DEPLOY_PREFIX AWS_REGION ICEBERG_ROLE_ARN

render() {  # render <name>  ->  reads sql/<name>.sql.tmpl, writes sql/_rendered/<name>.sql
  python3 - "$1" <<'PY'
import os, sys, pathlib
name = sys.argv[1]
root = pathlib.Path(os.environ["SCRIPT_DIR_PY"])
src  = root / "sql" / f"{name}.sql.tmpl"
if not src.exists():
    sys.exit(0)
text = src.read_text()
for var in ("S3_BUCKET", "DEPLOY_PREFIX", "AWS_REGION", "ICEBERG_ROLE_ARN"):
    text = text.replace("${%s}" % var, os.environ[var])
out = root / "sql" / "_rendered" / f"{name}.sql"
out.write_text(text)
print(f">>> Rendered sql/_rendered/{name}.sql")
PY
}

SCRIPT_DIR_PY="$SCRIPT_DIR" export SCRIPT_DIR_PY
for tmpl in 01_setup run_genome_ingest_job; do
  render "$tmpl"
done

# ── Create AWS secrets (inline; values never hit a rendered file) ─────────────
echo ">>> Creating AWS secrets in GRAGEN_DB.GRAGEN…"
snow sql -c "$GRAGEN_CONNECTION" -q "
CREATE DATABASE IF NOT EXISTS GRAGEN_DB;
CREATE SCHEMA IF NOT EXISTS GRAGEN_DB.GRAGEN;
CREATE SECRET IF NOT EXISTS GRAGEN_DB.GRAGEN.AWS_ACCESS_KEY_ID
  TYPE = GENERIC_STRING SECRET_STRING = '${AWS_ACCESS_KEY_ID}';
CREATE SECRET IF NOT EXISTS GRAGEN_DB.GRAGEN.AWS_SECRET_ACCESS_KEY
  TYPE = GENERIC_STRING SECRET_STRING = '${AWS_SECRET_ACCESS_KEY}';
"

# ── Run main setup (db / wh / pool / EAIs / external volume / table / role) ────
echo ">>> Running sql/_rendered/01_setup.sql…"
snow sql -c "$GRAGEN_CONNECTION" -f "${RENDER_DIR}/01_setup.sql"

# ── Print IAM trust-policy gate ───────────────────────────────────────────────
echo ""
echo ">>> Reading GENOMICS_ICEBERG_VOLUME trust details…"
snow sql -c "$GRAGEN_CONNECTION" -q "DESC EXTERNAL VOLUME GENOMICS_ICEBERG_VOLUME;" || true

cat <<'GATE'

┌──────────────────────────────────────────────────────────────────────────┐
│  ACTION REQUIRED — update your IAM role trust policy                        │
│                                                                            │
│  From the DESC output above (STORAGE_LOCATION_1), copy:                     │
│    - STORAGE_AWS_IAM_USER_ARN                                               │
│    - STORAGE_AWS_EXTERNAL_ID                                                │
│  and add them to the trust policy of the role in ICEBERG_ROLE_ARN.         │
│  The role's permissions policy must allow s3:GetObject/PutObject/Delete    │
│  and s3:ListBucket on  s3://$S3_BUCKET/$DEPLOY_PREFIX/iceberg/*            │
│                                                                            │
│  THEN load the annotation tables + deploy:                                 │
│    snow sql -c $GRAGEN_CONNECTION -f sql/02_external_functions.sql         │
│    # run the build_*_iceberg loaders (see README)                          │
│    bash deploy.sh                                                          │
└──────────────────────────────────────────────────────────────────────────┘
GATE
echo "=== Setup complete ==="
