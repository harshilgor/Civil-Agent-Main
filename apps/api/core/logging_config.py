"""Structured logging via :mod:`structlog`.

All log events emit JSON with a stable set of fields:

* ``timestamp`` (ISO-8601 UTC)
* ``level``
* ``logger``
* ``event`` (the message key)
* ``service`` = ``civilagent.api`` / ``civilagent.worker`` / ``civilagent.parser``

Plus any contextual fields bound on the local logger via
``log.bind(...)``. We deliberately *do not* log raw file contents — only
metadata + hashed identifiers.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

import structlog

from apps.api.core.config import get_settings


def _build_processors(json_output: bool) -> list[Any]:
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]
    if json_output:
        shared.append(structlog.processors.JSONRenderer())
    else:
        shared.append(structlog.dev.ConsoleRenderer(colors=False))
    return shared


def configure_logging(*, service: str) -> None:
    settings = get_settings()
    json_output = settings.log_format == "json"

    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(message)s",
        stream=sys.stdout,
    )

    structlog.configure(
        processors=_build_processors(json_output),
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelName(settings.log_level.upper())
        ),
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    structlog.contextvars.bind_contextvars(
        service=service,
        env=settings.civilagent_env,
        parser_version=settings.parser_version,
        pid=os.getpid(),
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
