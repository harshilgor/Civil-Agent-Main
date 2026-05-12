"""Redis client + progress publishing helpers.

The worker writes to two Redis pub/sub channels:

* ``parse-progress:{geometry_id}`` — Agent 1 (geometry parsing) and
  Agent 3 (scheme generation) reuse this channel because both are
  geometry-scoped.
* ``sizing-progress:{scheme_id}`` — Agent 4 (member sizing) is
  scheme-scoped, so it gets its own channel. This avoids cross-talk
  between concurrent sizing runs on different schemes.

State keys mirror channels so reconnecting WebSocket clients can
replay the last snapshot:

* ``parse-progress:state:{geometry_id}``
* ``sizing-progress:state:{scheme_id}``
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import Any

from redis.asyncio import Redis

from apps.api.core.config import get_settings
from packages.engine.geometry_parser.progress import ProgressEvent, ProgressSink

log = logging.getLogger(__name__)


def _channel(geometry_id: str) -> str:
    return f"parse-progress:{geometry_id}"


def _state_key(geometry_id: str) -> str:
    return f"parse-progress:state:{geometry_id}"


def _sizing_channel(scheme_id: str) -> str:
    return f"sizing-progress:{scheme_id}"


def _sizing_state_key(scheme_id: str) -> str:
    return f"sizing-progress:state:{scheme_id}"


@lru_cache(maxsize=1)
def get_redis() -> Redis:
    settings = get_settings()
    return Redis.from_url(settings.redis_url, decode_responses=True)


class RedisProgressSink:
    """Implements :class:`ProgressSink` against Redis pub/sub.

    On every event we:
      1. Publish the event JSON on the channel.
      2. Overwrite the state key with the same payload so reconnecting
         clients can replay the latest snapshot.
    """

    def __init__(self, geometry_id: str, redis: Redis | None = None) -> None:
        self._geometry_id = geometry_id
        self._redis = redis or get_redis()

    async def publish(self, event: ProgressEvent) -> None:
        payload = event.model_dump_json()
        try:
            pipe = self._redis.pipeline(transaction=False)
            pipe.publish(_channel(self._geometry_id), payload)
            pipe.set(_state_key(self._geometry_id), payload, ex=24 * 3600)
            await pipe.execute()
        except Exception:
            log.exception(
                "redis.progress_publish_failed",
                extra={"geometry_id": self._geometry_id},
            )


async def get_last_snapshot(geometry_id: str) -> dict[str, Any] | None:
    redis = get_redis()
    raw = await redis.get(_state_key(geometry_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def progress_channel(geometry_id: str) -> str:
    return _channel(geometry_id)


def progress_sink_for(geometry_id: str) -> ProgressSink:
    return RedisProgressSink(geometry_id)


# ---------------------------------------------------------------------------
# Sizing-progress (Agent 4) — scheme-scoped channel.
# ---------------------------------------------------------------------------


class SizingProgressSink:
    """Same publish/state semantics as :class:`RedisProgressSink`,
    keyed by ``scheme_id`` instead of ``geometry_id``.

    Agent 4 explicitly does not reuse the parse-progress channel: a
    project may have several schemes and each can be sized
    independently, so binding events to scheme id avoids confusing
    cross-traffic. The frontend WS subscriber chooses the right
    channel based on the page it's on.
    """

    def __init__(self, scheme_id: str, redis: Redis | None = None) -> None:
        self._scheme_id = scheme_id
        self._redis = redis or get_redis()

    async def publish(self, event: ProgressEvent) -> None:
        payload = event.model_dump_json()
        try:
            pipe = self._redis.pipeline(transaction=False)
            pipe.publish(_sizing_channel(self._scheme_id), payload)
            pipe.set(
                _sizing_state_key(self._scheme_id),
                payload,
                ex=24 * 3600,
            )
            await pipe.execute()
        except Exception:
            log.exception(
                "redis.sizing_publish_failed",
                extra={"scheme_id": self._scheme_id},
            )


async def get_last_sizing_snapshot(scheme_id: str) -> dict[str, Any] | None:
    redis = get_redis()
    raw = await redis.get(_sizing_state_key(scheme_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def sizing_progress_channel(scheme_id: str) -> str:
    return _sizing_channel(scheme_id)


def sizing_progress_sink_for(scheme_id: str) -> ProgressSink:
    return SizingProgressSink(scheme_id)
