"""File upload routes — presigned S3 URLs scoped per tenant."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from apps.api.core.auth import CurrentUser, project_dep
from apps.api.core.config import Settings, get_settings
from apps.api.core.db import Project, ProjectFile, get_session
from apps.api.core.errors import BadRequest, NotFound
from apps.api.core.metrics import UPLOAD_PRESIGNED_TOTAL
from apps.api.core.s3 import presign_download, presign_upload
from apps.api.core.logging_config import get_logger
from apps.api.schemas import (
    FileDownloadUrlResponse,
    FileRegisterRequest,
    UploadUrlRequest,
    UploadUrlResponse,
)

router = APIRouter(prefix="/api/projects/{project_id}/files", tags=["files"])

log = get_logger(__name__)


@router.post(
    "/upload-url",
    response_model=UploadUrlResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_upload_url(
    body: UploadUrlRequest,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> UploadUrlResponse:
    ext = Path(body.filename).suffix.lower().lstrip(".")
    if not ext:
        UPLOAD_PRESIGNED_TOTAL.labels(format="unknown", result="rejected").inc()
        raise BadRequest("FILENAME_NO_EXTENSION", "Filename must include an extension.")
    if ext not in settings.allowed_formats_set:
        UPLOAD_PRESIGNED_TOTAL.labels(format=ext, result="rejected").inc()
        raise BadRequest(
            "FORMAT_NOT_ALLOWED",
            f"File format '{ext}' is not in the allow-list.",
            allowed=sorted(settings.allowed_formats_set),
        )
    if not _content_type_allowed(body.contentType, ext):
        UPLOAD_PRESIGNED_TOTAL.labels(format=ext, result="rejected").inc()
        raise BadRequest(
            "CONTENT_TYPE_MISMATCH",
            f"Content-Type '{body.contentType}' does not match extension '.{ext}'.",
        )

    file_id = str(uuid.uuid4())
    url, key = presign_upload(
        org_id=principal.org_id,
        project_id=project.id,
        file_id=file_id,
        extension=ext,
        content_type=body.contentType,
        max_bytes=settings.max_upload_bytes,
    )

    pf = ProjectFile(
        id=file_id,
        project_id=project.id,
        original_filename=body.filename,
        file_format=ext,
        s3_key=key,
        content_type=body.contentType,
    )
    session.add(pf)
    await session.commit()

    UPLOAD_PRESIGNED_TOTAL.labels(format=ext, result="ok").inc()
    log.info(
        "files.presigned",
        org_id=principal.org_id,
        project_id=project.id,
        file_id=file_id,
        format=ext,
    )

    return UploadUrlResponse(
        fileId=file_id,
        presignedUrl=url,
        expiresInSeconds=settings.s3_presign_ttl_seconds,
        s3Key=key,
        maxBytes=settings.max_upload_bytes,
    )


@router.post(
    "/{file_id}/registered",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def confirm_uploaded(
    file_id: str,
    body: FileRegisterRequest,
    project: Annotated[Project, Depends(project_dep)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> None:
    """Frontend calls this after S3 upload completes so the API can
    persist the file size + sha256 (used for idempotency)."""
    if body.fileId != file_id:
        raise BadRequest("FILE_ID_MISMATCH", "fileId in path does not match body.")

    pf = await session.get(ProjectFile, file_id)
    if pf is None or pf.project_id != project.id:
        raise NotFound("FILE_NOT_FOUND", "File not found in this project.")
    pf.file_size_bytes = body.fileSize
    pf.file_sha256 = body.sha256
    await session.commit()


@router.get(
    "/{file_id}/download-url",
    response_model=FileDownloadUrlResponse,
)
async def get_download_url(
    file_id: str,
    project: Annotated[Project, Depends(project_dep)],
    principal: CurrentUser,
    settings: Annotated[Settings, Depends(get_settings)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> FileDownloadUrlResponse:
    """Return a short-lived presigned S3 GET URL for one project file.

    The frontend uses this to stream the original IFC into the browser-side
    That Open IfcLoader for the source-model visualisation layer.
    """
    pf = await session.get(ProjectFile, file_id)
    if pf is None or pf.project_id != project.id:
        raise NotFound("FILE_NOT_FOUND", "File not found in this project.")
    if not pf.s3_key:
        raise NotFound("FILE_KEY_MISSING", "File has no S3 key on record.")

    url = presign_download(key=pf.s3_key, ttl_seconds=settings.s3_presign_ttl_seconds)
    log.info(
        "files.download_url",
        org_id=principal.org_id,
        project_id=project.id,
        file_id=file_id,
        format=pf.file_format,
    )
    return FileDownloadUrlResponse(
        fileId=file_id,
        downloadUrl=url,
        expiresInSeconds=settings.s3_presign_ttl_seconds,
        filename=pf.original_filename,
        fileFormat=pf.file_format or "",
    )


_CONTENT_TYPE_ALLOWLIST: dict[str, set[str]] = {
    "ifc": {"application/x-step", "application/octet-stream", "model/ifc"},
    "dxf": {"application/dxf", "image/vnd.dxf", "application/octet-stream"},
    "dwg": {"application/acad", "application/octet-stream", "image/vnd.dwg"},
    "pdf": {"application/pdf"},
}


def _content_type_allowed(content_type: str, ext: str) -> bool:
    return content_type.lower() in _CONTENT_TYPE_ALLOWLIST.get(ext, set())
