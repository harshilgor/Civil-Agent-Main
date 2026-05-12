"""Centralised settings — loaded once, validated at startup."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # Service identity
    civilagent_env: Literal["local", "dev", "staging", "prod"] = "local"
    parser_version: str = "1.0.0"
    schema_version: str = "parsed_geometry@1.0.0"

    # Postgres
    database_url: str = "postgresql+asyncpg://civilagent:civilagent@localhost:5432/civilagent"
    database_pool_size: int = 10
    database_max_overflow: int = 5

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # S3
    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str = "civilagent-uploads"
    s3_access_key_id: str = "test"
    s3_secret_access_key: str = "test"
    s3_presign_ttl_seconds: int = 900

    # Upload constraints
    max_upload_bytes: int = 524_288_000
    allowed_formats: str = "ifc,dxf,dwg,pdf"

    # Parsing
    parse_timeout_seconds: int = 600
    worker_max_jobs: int = 4

    # Anthropic
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-20250514"

    # Auth
    auth_jwt_audience: str = "civilagent"
    auth_jwt_issuer: str = "https://auth.civilagent.local"
    auth_jwks_url: str = ""
    auth_jwt_org_claim: str = "org_id"
    auth_jwt_algorithms: str = "RS256,ES256"
    auth_jwks_cache_ttl_seconds: int = 900
    auth_dev_bypass: bool = True

    @property
    def auth_jwt_algorithms_list(self) -> list[str]:
        return [a.strip() for a in self.auth_jwt_algorithms.split(",") if a.strip()]

    # Observability
    log_level: str = "INFO"
    log_format: Literal["json", "text"] = "json"
    metrics_enabled: bool = True
    metrics_port: int = 9090

    @property
    def allowed_formats_set(self) -> set[str]:
        return {f.strip().lower() for f in self.allowed_formats.split(",") if f.strip()}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
