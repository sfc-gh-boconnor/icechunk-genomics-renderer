#!/usr/bin/env bash
# =============================================================================
# GRAGEN Genomics Accelerator — Preflight Prerequisite Check
# =============================================================================
# Verifies every prerequisite before you run setup.sh / provision_aws.sh /
# deploy.sh, so failures surface up front with clear guidance instead of
# halfway through a deploy.
#
# Checks:
#   1. Required CLIs:  snow, docker (+ buildx + daemon), aws, python3
#   2. config.env present + required vars set + DEPLOY_PREFIX valid
#   3. Snowflake connection works and the active role is ACCOUNTADMIN
#   4. AWS CLI is authenticated (sts get-caller-identity)
#   5. Region colocation: Snowflake account region == AWS_REGION (perf)
#
# Usage:
#   bash preflight.sh            # full check (Snowflake + AWS + Docker)
#   bash preflight.sh --no-aws   # skip AWS checks
#   bash preflight.sh --no-docker# skip Docker checks (e.g. SQL-only work)
#
# Exit code 0 = all hard requirements met; non-zero = at least one failed.
# setup.sh and deploy.sh invoke this automatically.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CHECK_AWS=true
CHECK_DOCKER=true
for arg in "$@"; do
  case "$arg" in
    --no-aws)    CHECK_AWS=false ;;
    --no-docker) CHECK_DOCKER=false ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

FAILED=0
WARNED=0

ok()   { printf '  [ \033[0;32mOK\033[0m ]  %s\n' "$1"; }
fail() { printf '  [\033[0;31mFAIL\033[0m]  %s\n' "$1"; FAILED=$((FAILED+1)); }
warn() { printf '  [\033[0;33mWARN\033[0m]  %s\n' "$1"; WARNED=$((WARNED+1)); }

echo "================================================================"
echo " GRAGEN Genomics Accelerator — preflight prerequisite check"
echo "================================================================"

# ── 1. Required CLIs ──────────────────────────────────────────────────────────
echo
echo "1. Command-line tools"

if command -v snow >/dev/null 2>&1; then
  ok "snow CLI found ($(snow --version 2>/dev/null | head -1))"
else
  fail "snow CLI not found. Install: pip install snowflake-cli-labs  (https://docs.snowflake.com/en/developer-guide/snowflake-cli/installation/installation)"
fi

if command -v python3 >/dev/null 2>&1; then
  ok "python3 found ($(python3 --version 2>&1))"
else
  fail "python3 not found. setup.sh uses it to render SQL templates."
fi

if [[ "$CHECK_DOCKER" == true ]]; then
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      ok "docker found and daemon is running ($(docker --version 2>/dev/null))"
    else
      fail "docker is installed but the daemon is NOT running. Start Docker Desktop (or 'sudo systemctl start docker') and retry."
    fi
    if docker buildx version >/dev/null 2>&1; then
      ok "docker buildx available ($(docker buildx version 2>/dev/null | head -1))"
    else
      fail "docker buildx not available. Images are built with 'docker buildx build --platform linux/amd64'. Install/enable buildx."
    fi
  else
    fail "docker not found. Required to build + push SPCS service images. Install Docker Desktop (https://docs.docker.com/get-docker/)."
  fi
else
  warn "Docker checks skipped (--no-docker). deploy.sh will need Docker."
fi

if [[ "$CHECK_AWS" == true ]]; then
  if command -v aws >/dev/null 2>&1; then
    ok "aws CLI found ($(aws --version 2>&1 | head -1))"
  else
    fail "aws CLI not found. Required by provision_aws.sh. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi
fi

# ── 2. config.env ─────────────────────────────────────────────────────────────
echo
echo "2. Configuration (config.env)"

CONFIG_OK=true
if [[ -f "${SCRIPT_DIR}/config.env" ]]; then
  ok "config.env found"
  # shellcheck disable=SC1090
  source "${SCRIPT_DIR}/config.env"
else
  fail "config.env not found. Copy config.env.example to config.env and edit it."
  CONFIG_OK=false
fi

if [[ "$CONFIG_OK" == true ]]; then
  for v in GRAGEN_CONNECTION DEPLOY_PREFIX S3_BUCKET AWS_REGION; do
    if [[ -n "${!v:-}" ]]; then
      ok "$v = ${!v}"
    else
      fail "$v is not set in config.env"
    fi
  done

  # These get auto-filled by provision_aws.sh; warn (not fail) if still empty.
  for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY ICEBERG_ROLE_ARN; do
    if [[ -n "${!v:-}" ]]; then
      ok "$v is set"
    else
      warn "$v is empty — run 'bash provision_aws.sh' to create AWS resources and auto-fill it."
    fi
  done

  if [[ -n "${DEPLOY_PREFIX:-}" ]]; then
    if [[ "$DEPLOY_PREFIX" =~ ^[a-z0-9_]+$ ]]; then
      ok "DEPLOY_PREFIX format valid (lowercase/digits/underscore)"
    else
      fail "DEPLOY_PREFIX must match ^[a-z0-9_]+\$ (lowercase letters, digits, underscores). Got: '$DEPLOY_PREFIX'"
    fi
  fi
fi

CONN="${GRAGEN_CONNECTION:-}"

# ── 3. Snowflake connection + role ────────────────────────────────────────────
echo
echo "3. Snowflake connection"

if ! command -v snow >/dev/null 2>&1; then
  warn "Skipping Snowflake checks (snow CLI missing)."
elif [[ -z "$CONN" ]]; then
  warn "Skipping Snowflake checks (GRAGEN_CONNECTION not set)."
else
  if snow connection test -c "$CONN" >/dev/null 2>&1; then
    ok "connection '$CONN' authenticates successfully"

    ROLE=$(snow sql -c "$CONN" -q "SELECT CURRENT_ROLE() AS R" --format json 2>/dev/null \
            | python3 -c "import sys,json;print(json.load(sys.stdin)[0].get('R',''))" 2>/dev/null || true)
    if [[ "$ROLE" == "ACCOUNTADMIN" ]]; then
      ok "active role is ACCOUNTADMIN"
    elif [[ -n "$ROLE" ]]; then
      warn "active role is '$ROLE', not ACCOUNTADMIN. Setup creates account-level objects (external volume, compute pools). Use a credential with multi-role access including ACCOUNTADMIN."
    else
      warn "could not determine active role. Ensure the credential allows multi-role access including ACCOUNTADMIN."
    fi

    # ── 4/5. Region colocation ────────────────────────────────────────────────
    SF_REGION=$(snow sql -c "$CONN" -q "SELECT CURRENT_REGION() AS R" --format json 2>/dev/null \
            | python3 -c "import sys,json;print(json.load(sys.stdin)[0].get('R',''))" 2>/dev/null || true)
    if [[ -n "$SF_REGION" && -n "${AWS_REGION:-}" ]]; then
      # CURRENT_REGION() -> e.g. AWS_US_WEST_2 ; normalize to us-west-2
      NORM=$(echo "$SF_REGION" | sed -E 's/^(AWS|AZURE|GCP)_//I' | tr '[:upper:]' '[:lower:]' | tr '_' '-')
      if [[ "$NORM" == "${AWS_REGION}" ]]; then
        ok "region colocation OK (Snowflake $SF_REGION ≈ S3 $AWS_REGION)"
      else
        warn "REGION MISMATCH: Snowflake account is $SF_REGION (~$NORM) but AWS_REGION=$AWS_REGION. Cross-region S3 writes make Zarr ingest much slower — colocate the bucket with the account region."
      fi
    fi
  else
    fail "connection '$CONN' failed. Check ~/.snowflake/connections.toml and run: snow connection test -c $CONN"
  fi
fi

# ── 4. AWS auth ───────────────────────────────────────────────────────────────
echo
echo "4. AWS authentication"

if [[ "$CHECK_AWS" != true ]]; then
  warn "AWS checks skipped (--no-aws)."
elif ! command -v aws >/dev/null 2>&1; then
  warn "Skipping AWS auth check (aws CLI missing)."
else
  IDENT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  if [[ -n "$IDENT" && "$IDENT" != "None" ]]; then
    ok "AWS CLI authenticated (account $IDENT)"
  else
    fail "AWS CLI not authenticated. provision_aws.sh needs valid credentials (IAM user keys or temp STS creds via aws_temp.env). Run: aws sts get-caller-identity"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "================================================================"
if [[ "$FAILED" -gt 0 ]]; then
  printf ' Result: \033[0;31m%d prerequisite(s) FAILED\033[0m, %d warning(s).\n' "$FAILED" "$WARNED"
  echo " Fix the FAILED items above before continuing."
  echo "================================================================"
  exit 1
elif [[ "$WARNED" -gt 0 ]]; then
  printf ' Result: \033[0;32mall hard prerequisites met\033[0m, %d warning(s) to review.\n' "$WARNED"
  echo "================================================================"
  exit 0
else
  printf ' Result: \033[0;32mall prerequisites met.\033[0m You are ready to deploy.\n'
  echo "================================================================"
  exit 0
fi
