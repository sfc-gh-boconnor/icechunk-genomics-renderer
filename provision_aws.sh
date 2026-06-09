#!/usr/bin/env bash
# =============================================================================
# GRAGEN — AWS provisioner (shared AWS account, per-prefix isolation)
# =============================================================================
# Each SE has their own Snowflake account but SHARES one AWS account. A unique
# DEPLOY_PREFIX (from config.env) namespaces this SE's S3 paths and IAM names so
# nothing collides:
#   bucket:  s3://<S3_BUCKET>/<DEPLOY_PREFIX>/{genomics_repo,clinvar_repo,iceberg}/
#   IAM user: <DEPLOY_PREFIX>_gragen_zarr_user   (read/write on <prefix>/* only)
#   IAM role: <DEPLOY_PREFIX>_gragen_iceberg_role (external volume; <prefix>/iceberg/*)
#
# AWS auth: uses your ambient AWS CLI credentials (env vars / SSO / profile).
# For convenience, if a gitignored aws_temp.env exists it is sourced first.
#
# Usage:
#   bash provision_aws.sh            # phase 1: bucket + IAM user(+key) + role(+policy)
#   bash setup.sh                    # (Snowflake side: creates the external volume)
#   bash provision_aws.sh --trust    # phase 2: set role trust from the volume's DESC
#   bash deploy.sh
#
# Idempotent: re-running skips objects that already exist.
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PHASE="provision"
[[ "${1:-}" == "--trust" ]] && PHASE="trust"

# ── Load config + (optional) temp creds ───────────────────────────────────────
[[ -f ./config.env ]] || { echo "ERROR: config.env not found (copy config.env.example)." >&2; exit 1; }
# shellcheck disable=SC1091
source ./config.env
if [[ -f ./aws_temp.env ]]; then
  # shellcheck disable=SC1091
  set -a; source ./aws_temp.env; set +a
fi

: "${DEPLOY_PREFIX:?set in config.env}"
: "${S3_BUCKET:?set in config.env}"
: "${AWS_REGION:?set in config.env}"
: "${GRAGEN_CONNECTION:?set in config.env}"

if [[ ! "$DEPLOY_PREFIX" =~ ^[a-z0-9_]+$ ]]; then
  echo "ERROR: DEPLOY_PREFIX must match ^[a-z0-9_]+\$ (got '$DEPLOY_PREFIX')." >&2; exit 1
fi

USER_NAME="${DEPLOY_PREFIX}_gragen_zarr_user"
ROLE_NAME="${DEPLOY_PREFIX}_gragen_iceberg_role"
command -v aws >/dev/null || { echo "ERROR: aws CLI not found." >&2; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
  || { echo "ERROR: AWS credentials not working (check aws_temp.env / SSO / env)." >&2; exit 1; }
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# =============================================================================
# Phase 2: finalize the IAM role trust policy from the external volume's DESC
# =============================================================================
if [[ "$PHASE" == "trust" ]]; then
  echo "== Reading GENOMICS_ICEBERG_VOLUME trust details from $GRAGEN_CONNECTION =="
  DESC_JSON="$(snow sql -c "$GRAGEN_CONNECTION" --format json \
    -q "DESC EXTERNAL VOLUME GENOMICS_ICEBERG_VOLUME" 2>/dev/null)" \
    || { echo "ERROR: DESC EXTERNAL VOLUME failed — run setup.sh first." >&2; exit 1; }

  read -r IAM_USER_ARN EXTERNAL_ID < <(python3 - "$DESC_JSON" <<'PY'
import json, sys
rows = json.loads(sys.argv[1])
prop = {}
for r in rows:
    r = { (k.lower()): v for k, v in r.items() }
    name = r.get("property") or r.get("property_name")
    val  = r.get("property_value") or r.get("value")
    if name and val is not None:
        prop[name] = val
# STORAGE_LOCATION_1 value is a JSON blob with the storage details
loc = prop.get("STORAGE_LOCATION_1", "")
arn = ext = ""
try:
    j = json.loads(loc)
    arn = j.get("STORAGE_AWS_IAM_USER_ARN", "")
    ext = j.get("STORAGE_AWS_EXTERNAL_ID", "")
except Exception:
    arn = prop.get("STORAGE_AWS_IAM_USER_ARN", "")
    ext = prop.get("STORAGE_AWS_EXTERNAL_ID", "")
print(arn, ext)
PY
)
  if [[ -z "${IAM_USER_ARN:-}" || -z "${EXTERNAL_ID:-}" ]]; then
    echo "ERROR: could not parse STORAGE_AWS_IAM_USER_ARN / EXTERNAL_ID from DESC." >&2
    echo "Run: snow sql -c $GRAGEN_CONNECTION -q \"DESC EXTERNAL VOLUME GENOMICS_ICEBERG_VOLUME\"" >&2
    exit 1
  fi
  echo "  Snowflake IAM user: $IAM_USER_ARN"
  echo "  External id:        $EXTERNAL_ID"

  TRUST_DOC="$(python3 - "$IAM_USER_ARN" "$EXTERNAL_ID" <<'PY'
import json, sys
arn, ext = sys.argv[1], sys.argv[2]
print(json.dumps({"Version":"2012-10-17","Statement":[{
  "Effect":"Allow","Principal":{"AWS":arn},"Action":"sts:AssumeRole",
  "Condition":{"StringEquals":{"sts:ExternalId":ext}}}]}))
PY
)"
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
    --policy-document "$TRUST_DOC" && echo "== role $ROLE_NAME trust policy updated =="
  exit 0
fi

# =============================================================================
# Phase 1: bucket + IAM user (+ access key) + IAM role (+ S3 policy)
# =============================================================================
echo "== Provisioning for prefix '${DEPLOY_PREFIX}' in account ${ACCOUNT_ID} =="

echo "== 1. Bucket s3://${S3_BUCKET} (${AWS_REGION}) — shared; created if missing =="
if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  echo "  bucket already exists — reusing (shared across SEs)"
else
  aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" \
    --create-bucket-configuration LocationConstraint="$AWS_REGION" 2>&1 \
    | grep -v -i 'already' || true
fi
# best-effort (org SCP may deny this) — buckets are private by default anyway
aws s3api put-public-access-block --bucket "$S3_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null 2>&1 \
  && echo "  public access blocked" || echo "  (public-access-block skipped — org SCP; non-fatal)"

echo "== 2. IAM user ${USER_NAME} =="
aws iam create-user --user-name "$USER_NAME" >/dev/null 2>&1 \
  && echo "  created" || echo "  already exists — reusing"

echo "== 3. User S3 policy (read/write s3://${S3_BUCKET}/${DEPLOY_PREFIX}/*) =="
USER_POLICY="$(python3 - "$S3_BUCKET" "$DEPLOY_PREFIX" <<'PY'
import json, sys
b, p = sys.argv[1], sys.argv[2]
print(json.dumps({"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],
   "Resource":f"arn:aws:s3:::{b}","Condition":{"StringLike":{"s3:prefix":[f"{p}/*"]}}},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],
   "Resource":f"arn:aws:s3:::{b}/{p}/*"}]}))
PY
)"
aws iam put-user-policy --user-name "$USER_NAME" \
  --policy-name gragen-zarr-s3 --policy-document "$USER_POLICY" && echo "  applied"

echo "== 4. Access key for ${USER_NAME} (secret -> config.env, never printed) =="
if grep -qE '^AWS_ACCESS_KEY_ID="AKIA' config.env 2>/dev/null; then
  echo "  config.env already has a durable key — skipping (avoids IAM 2-key limit)"
else
  if aws iam create-access-key --user-name "$USER_NAME" --output json > /tmp/gragen_ak.json 2>/tmp/gragen_ak_err.txt; then
    python3 - <<'PY'
import json, re, pathlib
ak = json.load(open("/tmp/gragen_ak.json"))["AccessKey"]
kid, sec = ak["AccessKeyId"], ak["SecretAccessKey"]
p = pathlib.Path("config.env"); t = p.read_text()
t = re.sub(r'AWS_ACCESS_KEY_ID="[^"]*"',     f'AWS_ACCESS_KEY_ID="{kid}"', t)
t = re.sub(r'AWS_SECRET_ACCESS_KEY="[^"]*"', f'AWS_SECRET_ACCESS_KEY="{sec}"', t)
p.write_text(t)
print(f"  wrote durable key {kid[:8]}... into config.env (secret not shown)")
PY
    shred -u /tmp/gragen_ak.json 2>/dev/null || rm -f /tmp/gragen_ak.json
  else
    echo "  !! create-access-key FAILED:"; cat /tmp/gragen_ak_err.txt; rm -f /tmp/gragen_ak_err.txt
  fi
fi

echo "== 5. IAM role ${ROLE_NAME} (placeholder trust = account root; finalized by --trust) =="
TRUST_PLACEHOLDER="$(python3 - "$ACCOUNT_ID" <<'PY'
import json, sys
print(json.dumps({"Version":"2012-10-17","Statement":[{
  "Effect":"Allow","Principal":{"AWS":f"arn:aws:iam::{sys.argv[1]}:root"},
  "Action":"sts:AssumeRole"}]}))
PY
)"
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_PLACEHOLDER" >/dev/null 2>&1 \
  && echo "  created" || echo "  already exists — reusing"

echo "== 6. Role S3 policy (s3://${S3_BUCKET}/${DEPLOY_PREFIX}/iceberg/*) =="
ROLE_POLICY="$(python3 - "$S3_BUCKET" "$DEPLOY_PREFIX" <<'PY'
import json, sys
b, p = sys.argv[1], sys.argv[2]
print(json.dumps({"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],
   "Resource":f"arn:aws:s3:::{b}","Condition":{"StringLike":{"s3:prefix":[f"{p}/iceberg/*"]}}},
  {"Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:PutObject","s3:DeleteObject"],
   "Resource":f"arn:aws:s3:::{b}/{p}/iceberg/*"}]}))
PY
)"
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name gragen-iceberg-s3 --policy-document "$ROLE_POLICY" && echo "  applied"

echo "== 7. Write ICEBERG_ROLE_ARN into config.env =="
python3 - "$ROLE_ARN" <<'PY'
import re, sys, pathlib
arn = sys.argv[1]
p = pathlib.Path("config.env"); t = p.read_text()
t = re.sub(r'ICEBERG_ROLE_ARN="[^"]*"', f'ICEBERG_ROLE_ARN="{arn}"', t)
p.write_text(t); print(f"  ICEBERG_ROLE_ARN={arn}")
PY

cat <<EOF

== phase 1 done ==
Next:
  1. bash setup.sh                  # creates the external volume in your Snowflake account
  2. bash provision_aws.sh --trust  # set the role trust policy from the volume DESC
  3. bash deploy.sh
EOF
