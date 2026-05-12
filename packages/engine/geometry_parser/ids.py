"""Deterministic identifier helpers.

Every entity ID emitted by the parser is derived from a stable hash of
the entity's defining content. This guarantees the determinism property
required by the contract (same input → identical output, byte-for-byte
ignoring timestamps) and lets downstream consumers reliably diff
versions.
"""

from __future__ import annotations

import hashlib
from typing import Any


_HASH_LENGTH = 10


def _digest(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:_HASH_LENGTH]


def _round(v: float, ndigits: int = 4) -> float:
    """Round-half-away-from-zero to keep floats stable across platforms.

    Python's bankers rounding can flip identical inputs across CPython
    versions / numpy releases; we standardise on a simple, observable
    rule.
    """
    if v == 0:
        return 0.0
    factor = 10**ndigits
    return float(int(v * factor + (0.5 if v > 0 else -0.5))) / factor


def level_id(name: str, elevation: float) -> str:
    return f"lvl_{_digest(f'{name}|{_round(elevation, 3)}')}"


def grid_id(axis: str, label: str, coordinate: float) -> str:
    return f"grd_{axis}_{_digest(f'{label}|{_round(coordinate, 3)}')}"


def core_id(centroid_x: float, centroid_y: float, core_type: str) -> str:
    return f"core_{_digest(f'{core_type}|{_round(centroid_x)}|{_round(centroid_y)}')}"


def column_id(x: float, y: float, start_level: str) -> str:
    return f"col_{_digest(f'{_round(x)}|{_round(y)}|{start_level}')}"


def opening_id(level_id_: str, x: float, y: float) -> str:
    return f"opn_{_digest(f'{level_id_}|{_round(x)}|{_round(y)}')}"


def zone_id(name: str, level_id_: str) -> str:
    return f"zon_{_digest(f'{name}|{level_id_}')}"


def file_hash(path: str | bytes, *, chunk_size: int = 1 << 20) -> str:
    """SHA-256 of file contents. Used as part of the idempotency key."""
    h = hashlib.sha256()
    if isinstance(path, bytes):
        h.update(path)
        return h.hexdigest()
    with open(path, "rb") as fp:
        while True:
            chunk = fp.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def idempotency_key(
    *,
    file_sha256: str,
    parser_version: str,
    project_id: str,
    force_token: str | None = None,
    options: dict[str, Any] | None = None,
) -> str:
    """Compose the idempotency key for a parse trigger.

    The key is the SHA-256 of a canonical concatenation of:

    * ``project_id`` — tenant scope.
    * ``file_sha256`` — content fingerprint of the uploaded file.
    * ``parser_version`` — bumping the parser invalidates prior results.
    * ``options`` — JSON-canonical encoding of any parser knobs that
      change the *semantic* output (page selection, future flags). Two
      triggers with different options must produce different keys, else
      Page 1 and Page 7 of the same PDF would dedupe against each other.
    * ``force_token`` — included when the caller requests a forced
      re-parse, making the key unique without polluting the
      deterministic dedupe path.
    """
    base = f"{project_id}|{file_sha256}|{parser_version}"
    if options:
        clean = {k: v for k, v in options.items() if v is not None}
        if clean:
            base += "|opts=" + stable_dump(clean)
    if force_token:
        base += f"|{force_token}"
    return hashlib.sha256(base.encode("utf-8")).hexdigest()


def stable_dump(value: Any) -> str:
    """JSON-stable canonical encoding for hashing / snapshot tests."""
    import json

    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
