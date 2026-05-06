"""
storage.py — S3 helpers for TakeOff Label.
Follows proEstimator pattern: single _s3() factory, clean upload/download interface.
"""
from __future__ import annotations

import io
import logging
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from config import settings

logger = logging.getLogger(__name__)


# Force SigV4 for presigned URLs. Without this, boto3 may emit SigV2 URLs that
# buckets in newer regions reject with: "The authorization mechanism you have
# provided is not supported. Please use AWS4-HMAC-SHA256."
_S3_CONFIG = Config(signature_version="s3v4")

# Resolved bucket region (cached after first lookup). Presigned URLs must be
# signed with the bucket's actual region — boto3 can transparently retry GETs
# on a region mismatch, but signed URLs are minted locally and don't get fixed.
_RESOLVED_REGION: str | None = None


def _bucket_region() -> str:
    """Return the actual region of the configured bucket, caching the result.
    Falls back to settings.aws_region on lookup failure."""
    global _RESOLVED_REGION
    if _RESOLVED_REGION:
        return _RESOLVED_REGION
    probe = boto3.client(
        "s3",
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        config=_S3_CONFIG,
    )
    region: str | None = None
    try:
        resp = probe.head_bucket(Bucket=settings.aws_s3_bucket)
        region = resp.get("ResponseMetadata", {}).get("HTTPHeaders", {}).get("x-amz-bucket-region")
    except ClientError as e:
        # On a region mismatch, S3 typically responds 301 with the correct
        # region in the x-amz-bucket-region header — surfaced via the error.
        region = e.response.get("ResponseMetadata", {}).get("HTTPHeaders", {}).get("x-amz-bucket-region")
        if not region:
            logger.warning("head_bucket failed without region header: %s", e)
    if region and region != settings.aws_region:
        logger.warning(
            "Bucket %r is in %s but configured region is %s — using %s for signing.",
            settings.aws_s3_bucket, region, settings.aws_region, region,
        )
    _RESOLVED_REGION = region or settings.aws_region
    return _RESOLVED_REGION


def _s3():
    return boto3.client(
        "s3",
        region_name=_bucket_region(),
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        config=_S3_CONFIG,
    )


# ── Upload / download ─────────────────────────────────────────────────────────

def upload_pdf(session_id: str, data: bytes, filename: str) -> str:
    key = f"label-sessions/{session_id}/source.pdf"
    _s3().put_object(
        Bucket=settings.aws_s3_bucket,
        Key=key, Body=data,
        ContentType="application/pdf",
        Metadata={"original-filename": filename},
    )
    logger.info("uploaded pdf: %s (%d bytes)", key, len(data))
    return key


def download_pdf(s3_key: str) -> bytes:
    obj = _s3().get_object(Bucket=settings.aws_s3_bucket, Key=s3_key)
    return obj["Body"].read()


def upload_page_png(session_id: str, page_number: int, png_bytes: bytes) -> str:
    key = f"label-sessions/{session_id}/pages/{page_number}.png"
    _s3().put_object(
        Bucket=settings.aws_s3_bucket,
        Key=key, Body=png_bytes,
        ContentType="image/png",
    )
    return key


def upload_page_svg(session_id: str, page_number: int, svg: str) -> str:
    key = f"label-sessions/{session_id}/pages/{page_number}.svg"
    _s3().put_object(
        Bucket=settings.aws_s3_bucket,
        Key=key,
        Body=svg.encode("utf-8"),
        ContentType="image/svg+xml",
    )
    return key


def download_text(s3_key: str) -> str:
    obj = _s3().get_object(Bucket=settings.aws_s3_bucket, Key=s3_key)
    return obj["Body"].read().decode("utf-8")


def page_png_exists(session_id: str, page_number: int) -> bool:
    key = f"label-sessions/{session_id}/pages/{page_number}.png"
    try:
        _s3().head_object(Bucket=settings.aws_s3_bucket, Key=key)
        return True
    except ClientError:
        return False


def upload_export_zip(export_id: str, zip_bytes: bytes) -> str:
    key = f"label-exports/{export_id}.zip"
    _s3().put_object(
        Bucket=settings.aws_s3_bucket,
        Key=key, Body=zip_bytes,
        ContentType="application/zip",
    )
    logger.info("uploaded export: %s (%d bytes)", key, len(zip_bytes))
    return key


# ── Presigned URLs ────────────────────────────────────────────────────────────

def presign_page(session_id: str, page_number: int, expires: int = 3600) -> str:
    key = f"label-sessions/{session_id}/pages/{page_number}.png"
    return _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.aws_s3_bucket, "Key": key},
        ExpiresIn=expires,
    )


def presign_export(export_id: str, expires: int = 3600) -> str:
    key = f"label-exports/{export_id}.zip"
    return _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.aws_s3_bucket, "Key": key},
        ExpiresIn=expires,
    )


# ── Cleanup ───────────────────────────────────────────────────────────────────

def delete_session_files(session_id: str):
    prefix = f"label-sessions/{session_id}/"
    s3 = _s3()
    paginator = s3.get_paginator("list_objects_v2")
    objects = []
    for page in paginator.paginate(Bucket=settings.aws_s3_bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            objects.append({"Key": obj["Key"]})
    if objects:
        s3.delete_objects(Bucket=settings.aws_s3_bucket, Delete={"Objects": objects})
        logger.info("deleted %d objects for session %s", len(objects), session_id)
