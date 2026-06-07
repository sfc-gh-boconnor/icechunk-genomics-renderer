"""
icechunk_client.py — open/create IceChunk repositories on S3.

Three repos supported (all in the same S3 bucket, different prefixes):
  - Genomics 1000G   (ICECHUNK_GENOMICS_PREFIX, default genomics_repo)
  - ClinVar          (ICECHUNK_CLINVAR_PREFIX,  default clinvar_repo)

Both live in the same S3 bucket (ICECHUNK_BUCKET, default icechunk-ro).
This avoids creating separate buckets / IAM users per dataset.
"""
import os
import icechunk
from icechunk.storage import s3_storage

BUCKET          = os.environ.get("ICECHUNK_BUCKET",          "icechunk-ro")
REGION          = os.environ.get("AWS_DEFAULT_REGION",        "us-west-2")
GENOMICS_PREFIX = os.environ.get("ICECHUNK_GENOMICS_PREFIX",  "genomics_repo")
CLINVAR_PREFIX  = os.environ.get("ICECHUNK_CLINVAR_PREFIX",   "clinvar_repo")


def _storage(prefix: str) -> icechunk.Storage:
    """Build an S3 storage backend for the given prefix."""
    aws_key    = os.environ.get("AWS_ACCESS_KEY_ID")
    aws_secret = os.environ.get("AWS_SECRET_ACCESS_KEY")
    kwargs: dict = dict(bucket=BUCKET, prefix=prefix, region=REGION)
    if aws_key and aws_secret:
        kwargs["access_key_id"]     = aws_key
        kwargs["secret_access_key"] = aws_secret
    else:
        kwargs["from_env"] = True
    return s3_storage(**kwargs)


def open_or_create_genomics_repo() -> icechunk.Repository:
    """Return the 1000G genomics repo, creating it if it doesn't exist yet."""
    storage = _storage(GENOMICS_PREFIX)
    try:
        return icechunk.Repository.open(storage=storage)
    except Exception:
        return icechunk.Repository.create(storage=storage)


def open_genomics_repo() -> icechunk.Repository:
    """Return the existing genomics repository (raises if not found)."""
    return icechunk.Repository.open(storage=_storage(GENOMICS_PREFIX))


def open_or_create_clinvar_repo() -> icechunk.Repository:
    """Return the ClinVar repo, creating it if it doesn't exist yet."""
    storage = _storage(CLINVAR_PREFIX)
    try:
        return icechunk.Repository.open(storage=storage)
    except Exception:
        return icechunk.Repository.create(storage=storage)


def open_clinvar_repo() -> icechunk.Repository:
    """Return the existing ClinVar repository (raises if not found)."""
    return icechunk.Repository.open(storage=_storage(CLINVAR_PREFIX))
