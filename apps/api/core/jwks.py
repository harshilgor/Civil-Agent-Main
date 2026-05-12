"""JWKS-backed JWT verifier.

Production-grade verification with PyJWT:

* Fetches the JWKS document from the configured ``AUTH_JWKS_URL``.
* Caches the decoded keyset by ``kid`` for ``AUTH_JWKS_CACHE_TTL_SECONDS``.
* On verification failure (kid not found, key cache miss), refreshes the
  cache **once** to handle key rotation, then re-verifies.
* Validates ``aud`` and ``iss`` against settings; algorithm allow-list
  comes from ``AUTH_JWT_ALGORITHMS`` so we never accept ``alg=none`` or
  symmetric ``HS*`` algorithms by accident.

The verifier is intentionally narrow: it returns either a validated
claims dict or raises :class:`AuthError` with a stable ``code``. Mapping
to HTTP status codes lives in ``apps/api/core/auth.py``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt import PyJWKClient, PyJWKSet
from jwt.algorithms import RSAAlgorithm  # noqa: F401  — surfaces import error early
from jwt.exceptions import (
    ExpiredSignatureError,
    InvalidAudienceError,
    InvalidAlgorithmError,
    InvalidIssuerError,
    InvalidSignatureError,
    InvalidTokenError,
    PyJWKClientError,
)

from apps.api.core.config import Settings, get_settings

log = logging.getLogger(__name__)


class AuthError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class _CachedKeyset:
    keyset: PyJWKSet
    fetched_at: float


class JwksVerifier:
    """Async JWKS verifier with TTL caching + single rotation retry."""

    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()
        self._cache: _CachedKeyset | None = None
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Cache management
    # ------------------------------------------------------------------

    async def _load_keyset(self, *, force: bool = False) -> PyJWKSet:
        ttl = self._settings.auth_jwks_cache_ttl_seconds
        now = time.monotonic()
        if not force and self._cache is not None and now - self._cache.fetched_at < ttl:
            return self._cache.keyset

        url = self._settings.auth_jwks_url
        if not url:
            raise AuthError(
                "AUTH_NOT_CONFIGURED",
                "AUTH_JWKS_URL is not configured.",
            )

        async with self._lock:
            # Re-check after lock acquisition (another coroutine may have
            # refreshed the cache while we waited).
            if not force and self._cache is not None and time.monotonic() - self._cache.fetched_at < ttl:
                return self._cache.keyset
            try:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    payload = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                log.exception("auth.jwks_fetch_failed", extra={"url": url})
                raise AuthError(
                    "AUTH_JWKS_FETCH_FAILED",
                    f"Failed to fetch JWKS document: {exc}",
                ) from exc
            try:
                keyset = PyJWKSet.from_dict(payload)
            except PyJWKClientError as exc:
                raise AuthError("AUTH_JWKS_INVALID", str(exc)) from exc
            self._cache = _CachedKeyset(keyset=keyset, fetched_at=time.monotonic())
            log.info("auth.jwks_loaded", extra={"keys": len(keyset.keys)})
            return self._cache.keyset

    @staticmethod
    def _find_kid(keyset: PyJWKSet, kid: str) -> Any | None:
        for jwk in keyset.keys:
            if getattr(jwk, "key_id", None) == kid:
                return jwk.key
        return None

    async def _resolve_signing_key(self, kid: str, *, allow_refresh: bool = True) -> Any:
        keyset = await self._load_keyset()
        key = self._find_kid(keyset, kid)
        if key is not None:
            return key
        if not allow_refresh:
            raise AuthError("AUTH_KID_UNKNOWN", f"kid '{kid}' not in JWKS.")
        # kid might have rotated since cache load — refresh once.
        log.info("auth.jwks_refresh_for_kid", extra={"kid": kid})
        keyset = await self._load_keyset(force=True)
        key = self._find_kid(keyset, kid)
        if key is None:
            raise AuthError(
                "AUTH_KID_UNKNOWN",
                f"kid '{kid}' not in JWKS after refresh.",
            )
        return key

    # ------------------------------------------------------------------
    # Verification
    # ------------------------------------------------------------------

    async def verify(self, token: str) -> dict[str, Any]:
        if not token:
            raise AuthError("AUTH_MISSING_TOKEN", "No bearer token supplied.")

        try:
            unverified = jwt.get_unverified_header(token)
        except InvalidTokenError as exc:
            raise AuthError("AUTH_MALFORMED_TOKEN", "Token header is invalid.") from exc

        kid = unverified.get("kid")
        if not kid:
            raise AuthError(
                "AUTH_MISSING_KID",
                "Token header is missing 'kid'; cannot select signing key.",
            )

        algorithms = self._settings.auth_jwt_algorithms_list
        if not algorithms or any(a.lower().startswith("hs") for a in algorithms) or "none" in algorithms:
            raise AuthError(
                "AUTH_ALG_INVALID",
                "Allow-list must contain only asymmetric algorithms (RS*/ES*/PS*).",
            )

        signing_key = await self._resolve_signing_key(kid)
        try:
            claims = jwt.decode(
                token,
                signing_key,
                algorithms=algorithms,
                audience=self._settings.auth_jwt_audience,
                issuer=self._settings.auth_jwt_issuer,
                options={"require": ["exp", "iat", "sub"]},
            )
        except ExpiredSignatureError as exc:
            raise AuthError("AUTH_TOKEN_EXPIRED", "Token has expired.") from exc
        except InvalidAudienceError as exc:
            raise AuthError("AUTH_AUDIENCE_INVALID", str(exc)) from exc
        except InvalidIssuerError as exc:
            raise AuthError("AUTH_ISSUER_INVALID", str(exc)) from exc
        except InvalidSignatureError as exc:
            raise AuthError("AUTH_SIGNATURE_INVALID", "Signature verification failed.") from exc
        except InvalidAlgorithmError as exc:
            raise AuthError("AUTH_ALG_INVALID", str(exc)) from exc
        except InvalidTokenError as exc:
            raise AuthError("AUTH_TOKEN_INVALID", str(exc)) from exc

        return claims


_verifier_singleton: JwksVerifier | None = None


def get_verifier() -> JwksVerifier:
    global _verifier_singleton
    if _verifier_singleton is None:
        _verifier_singleton = JwksVerifier()
    return _verifier_singleton


def reset_verifier_for_tests() -> None:
    """Reset the cached verifier so tests can rebind settings."""
    global _verifier_singleton
    _verifier_singleton = None
