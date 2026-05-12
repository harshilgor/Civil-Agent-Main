"""S3 client + presigned URL helpers."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Optional

import boto3
from botocore.client import Config

from apps.api.core.config import get_settings

log = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def s3_client() -> "boto3.client":  # type: ignore[name-defined]
    settings = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url or None,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=Config(signature_version="s3v4"),
    )


def tenant_scoped_key(*, org_id: str, project_id: str, file_id: str, ext: str) -> str:
    """Build the canonical object key.

    Includes the org id so tenant boundaries are visible at the storage
    layer — both for ACL enforcement and for forensic auditing.
    """
    safe_ext = ext.lower().strip(".") or "bin"
    return f"orgs/{org_id}/projects/{project_id}/uploads/{file_id}.{safe_ext}"


def presign_upload(
    *,
    org_id: str,
    project_id: str,
    file_id: str,
    extension: str,
    content_type: str,
    max_bytes: Optional[int] = None,
) -> tuple[str, str]:
    """Return ``(presigned_url, key)``."""
    settings = get_settings()
    key = tenant_scoped_key(
        org_id=org_id, project_id=project_id, file_id=file_id, ext=extension
    )
    params: dict[str, object] = {
        "Bucket": settings.s3_bucket,
        "Key": key,
        "ContentType": content_type,
    }
    if max_bytes is not None:
        params["ContentLength"] = max_bytes
    url = s3_client().generate_presigned_url(
        ClientMethod="put_object",
        Params=params,
        ExpiresIn=settings.s3_presign_ttl_seconds,
    )
    return url, key


def presign_download(*, key: str, ttl_seconds: int = 3600) -> str:
    """Return a presigned GET URL for the given object key."""
    settings = get_settings()
    return s3_client().generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": settings.s3_bucket, "Key": key},
        ExpiresIn=ttl_seconds,
    )


def download_to_path(*, key: str, dest_path: str) -> None:
    settings = get_settings()
    s3_client().download_file(Bucket=settings.s3_bucket, Key=key, Filename=dest_path)


def head_object(key: str) -> dict[str, object]:
    settings = get_settings()
    return s3_client().head_object(Bucket=settings.s3_bucket, Key=key)
