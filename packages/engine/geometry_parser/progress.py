"""Progress event protocol.

The parser is decoupled from any specific transport (Redis pub/sub,
WebSocket, in-memory queue). Callers inject a :class:`ProgressSink` —
the parser drives lifecycle events, the sink decides where they go.

This is the source of truth for the progress event schema. The frontend
contract is documented in ``docs/API.md``; if the schema changes here,
that document and the frontend renderer must change in lockstep.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from packages.engine.geometry_parser.constants import PARSE_STEPS, STEP_WEIGHTS

log = logging.getLogger(__name__)

SubstepStatus = Literal["pending", "in_progress", "complete", "failed", "skipped"]
JobStatus = Literal[
    "queued", "running", "in_progress", "completed", "partial", "failed", "timeout"
]


class Substep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    status: SubstepStatus = "pending"
    detail: str | None = None
    durationMs: int | None = None


class ProgressEvent(BaseModel):
    """Event payload sent to the frontend.

    The ``substeps`` list is a *full snapshot* on every event — clients
    replace, never merge. ``progress`` is monotonic non-decreasing per
    job and reaches 1.0 only on a terminal event.
    """

    model_config = ConfigDict(extra="forbid")

    jobId: str
    geometryId: str
    step: str
    status: JobStatus
    detail: str | None = None
    substeps: list[Substep]
    progress: float = Field(..., ge=0.0, le=1.0)
    timestamp: datetime
    terminal: bool = False
    errorCode: str | None = None


class ProgressSink(Protocol):
    """Transport-agnostic progress sink."""

    async def publish(self, event: ProgressEvent) -> None: ...


# ---------------------------------------------------------------------------
# In-memory + null sinks (used in tests + as a fallback when Redis is down)
# ---------------------------------------------------------------------------


class NullProgressSink:
    async def publish(self, event: ProgressEvent) -> None:  # noqa: ARG002
        return None


class InMemoryProgressSink:
    """Captures events for tests and reconnect snapshot replay."""

    def __init__(self) -> None:
        self.events: list[ProgressEvent] = []

    async def publish(self, event: ProgressEvent) -> None:
        self.events.append(event)


# ---------------------------------------------------------------------------
# Tracker — the active surface used inside the orchestrator
# ---------------------------------------------------------------------------


class ProgressTracker:
    """State machine that emits :class:`ProgressEvent` objects.

    Guarantees:

    * progress monotonicity — never decreases.
    * substeps is always a full snapshot ordered by :data:`PARSE_STEPS`.
    * exactly one terminal event per job.
    """

    def __init__(
        self,
        *,
        job_id: str,
        geometry_id: str,
        sink: ProgressSink,
        steps: tuple[str, ...] = PARSE_STEPS,
        weights: dict[str, float] = STEP_WEIGHTS,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.job_id = job_id
        self.geometry_id = geometry_id
        self._sink = sink
        self._steps = steps
        self._weights = weights
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._substeps: dict[str, Substep] = {s: Substep(name=s) for s in steps}
        self._step_started_at: dict[str, datetime] = {}
        self._last_progress = 0.0
        self._terminal_emitted = False
        self._lock = asyncio.Lock()

    # --- internal -------------------------------------------------------

    def _snapshot_substeps(self) -> list[Substep]:
        return [self._substeps[s].model_copy() for s in self._steps]

    def _compute_progress(self) -> float:
        total = 0.0
        for name in self._steps:
            ss = self._substeps[name]
            w = self._weights[name]
            if ss.status == "complete":
                total += w
            elif ss.status == "in_progress":
                total += w * 0.5
            elif ss.status == "failed":
                total += w  # failed counts as "done" for progress purposes
        return min(1.0, max(self._last_progress, total))

    async def _publish(
        self,
        *,
        step: str,
        status: JobStatus,
        detail: str | None,
        terminal: bool,
        error_code: str | None,
    ) -> None:
        if self._terminal_emitted:
            log.warning(
                "progress.publish_after_terminal",
                extra={"job_id": self.job_id, "geometry_id": self.geometry_id, "step": step},
            )
            return
        progress = self._compute_progress()
        if progress < self._last_progress:
            progress = self._last_progress
        self._last_progress = progress
        event = ProgressEvent(
            jobId=self.job_id,
            geometryId=self.geometry_id,
            step=step,
            status=status,
            detail=detail,
            substeps=self._snapshot_substeps(),
            progress=progress,
            timestamp=self._clock(),
            terminal=terminal,
            errorCode=error_code,
        )
        if terminal:
            self._terminal_emitted = True
        try:
            await self._sink.publish(event)
        except Exception:  # pragma: no cover — sink failure must never crash parser
            log.exception("progress.sink_failure", extra={"job_id": self.job_id})

    # --- public ---------------------------------------------------------

    async def start_step(self, step: str, *, detail: str | None = None) -> None:
        async with self._lock:
            if step not in self._substeps:
                raise ValueError(f"unknown step: {step}")
            ss = self._substeps[step]
            self._substeps[step] = ss.model_copy(update={"status": "in_progress", "detail": detail})
            self._step_started_at[step] = self._clock()
            await self._publish(
                step=step, status="in_progress", detail=detail, terminal=False, error_code=None
            )

    async def complete_step(self, step: str, *, detail: str | None = None) -> None:
        async with self._lock:
            ss = self._substeps[step]
            duration = self._duration_ms(step)
            self._substeps[step] = ss.model_copy(
                update={"status": "complete", "detail": detail, "durationMs": duration}
            )
            await self._publish(
                step=step, status="in_progress", detail=detail, terminal=False, error_code=None
            )

    async def fail_step(
        self, step: str, *, detail: str, error_code: str, terminal: bool = False
    ) -> None:
        async with self._lock:
            ss = self._substeps[step]
            duration = self._duration_ms(step)
            self._substeps[step] = ss.model_copy(
                update={"status": "failed", "detail": detail, "durationMs": duration}
            )
            for s in self._steps:
                if self._substeps[s].status == "pending":
                    self._substeps[s] = self._substeps[s].model_copy(update={"status": "skipped"})
            await self._publish(
                step=step,
                status="failed" if terminal else "in_progress",
                detail=detail,
                terminal=terminal,
                error_code=error_code,
            )

    async def emit_terminal(
        self,
        *,
        status: JobStatus,
        step: str = "complete",
        detail: str | None = None,
        error_code: str | None = None,
    ) -> None:
        async with self._lock:
            if status not in ("completed", "partial", "failed", "timeout"):
                raise ValueError(f"non-terminal status passed to emit_terminal: {status}")
            if step in self._substeps and self._substeps[step].status == "pending":
                self._substeps[step] = self._substeps[step].model_copy(
                    update={"status": "complete", "detail": detail}
                )
            self._last_progress = 1.0
            await self._publish(
                step=step, status=status, detail=detail, terminal=True, error_code=error_code
            )

    def _duration_ms(self, step: str) -> int | None:
        started = self._step_started_at.get(step)
        if started is None:
            return None
        return int((self._clock() - started).total_seconds() * 1000)

    def snapshot(self) -> dict[str, Any]:
        """Last-known state — used for WebSocket reconnect replay."""
        return {
            "jobId": self.job_id,
            "geometryId": self.geometry_id,
            "substeps": [s.model_dump() for s in self._snapshot_substeps()],
            "progress": self._last_progress,
            "terminal": self._terminal_emitted,
        }


ProgressFactory = Callable[[str, str], Awaitable[ProgressTracker]]
