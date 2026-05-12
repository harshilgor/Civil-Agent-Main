"""Centralised HTTP error taxonomy."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status


class APIError(HTTPException):
    """HTTP error carrying a structured ``code`` field."""

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail={
                "code": code,
                "message": message,
                "context": context or {},
            },
        )


class BadRequest(APIError):
    def __init__(self, code: str, message: str, **ctx: Any) -> None:
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            code=code,
            message=message,
            context=ctx,
        )


class Conflict(APIError):
    def __init__(self, code: str, message: str, **ctx: Any) -> None:
        super().__init__(
            status_code=status.HTTP_409_CONFLICT,
            code=code,
            message=message,
            context=ctx,
        )


class NotFound(APIError):
    def __init__(self, code: str, message: str, **ctx: Any) -> None:
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            code=code,
            message=message,
            context=ctx,
        )


class UnprocessableEntity(APIError):
    def __init__(self, code: str, message: str, **ctx: Any) -> None:
        super().__init__(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            code=code,
            message=message,
            context=ctx,
        )
