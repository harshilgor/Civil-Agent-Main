"""ARQ worker entry point.

Run with::

    arq apps.worker.worker.WorkerSettings
"""

from __future__ import annotations

from arq.connections import RedisSettings

from apps.api.core.config import get_settings
from apps.api.core.logging_config import configure_logging, get_logger
from apps.worker.jobs.calculate_sizing import calculate_sizing_job
from apps.worker.jobs.generate_schemes import generate_schemes_job
from apps.worker.jobs.parse_geometry import parse_geometry_job

log = get_logger(__name__)


async def startup(ctx: dict) -> None:  # noqa: ARG001
    configure_logging(service="civilagent.worker")
    log.info("worker.startup", parser_version=get_settings().parser_version)


async def shutdown(ctx: dict) -> None:  # noqa: ARG001
    log.info("worker.shutdown")


class WorkerSettings:
    functions = [parse_geometry_job, generate_schemes_job, calculate_sizing_job]
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = get_settings().worker_max_jobs
    job_timeout = max(get_settings().parse_timeout_seconds * 2, 1800)
    keep_result = 600
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
