"""Progress event protocol tests.

Covers the WebSocket / sink contract:

* Snapshot completeness — every event carries the full substep array.
* Monotonic progress — never decreases.
* Exactly one terminal event per job.
* Unknown step names are rejected.
"""

from __future__ import annotations

import pytest

from packages.engine.geometry_parser.progress import (
    InMemoryProgressSink,
    ProgressTracker,
)


@pytest.fixture
def sink() -> InMemoryProgressSink:
    return InMemoryProgressSink()


@pytest.fixture
def tracker(sink: InMemoryProgressSink) -> ProgressTracker:
    return ProgressTracker(job_id="job", geometry_id="geom", sink=sink)


@pytest.mark.asyncio
async def test_progress_is_monotonic(tracker, sink):
    await tracker.start_step("download")
    await tracker.complete_step("download", detail="ok")
    await tracker.start_step("init")
    await tracker.complete_step("init")
    await tracker.start_step("levels")
    await tracker.complete_step("levels", detail="3 levels")
    progresses = [e.progress for e in sink.events]
    assert progresses == sorted(progresses)


@pytest.mark.asyncio
async def test_full_substep_snapshot_every_event(tracker, sink):
    await tracker.start_step("download")
    for ev in sink.events:
        names = [s.name for s in ev.substeps]
        assert names[0] == "download"
        assert "complete" in names


@pytest.mark.asyncio
async def test_exactly_one_terminal_event(tracker, sink):
    await tracker.start_step("download")
    await tracker.emit_terminal(status="completed")
    await tracker.emit_terminal(status="completed")  # second call should be a no-op
    terminal = [e for e in sink.events if e.terminal]
    assert len(terminal) == 1
    assert terminal[0].progress == 1.0


@pytest.mark.asyncio
async def test_failed_step_marks_pending_substeps_skipped(tracker, sink):
    await tracker.start_step("download")
    await tracker.fail_step(
        "download", detail="boom", error_code="DOWNLOAD_FAIL", terminal=False
    )
    last = sink.events[-1]
    statuses = {s.name: s.status for s in last.substeps}
    assert statuses["download"] == "failed"
    assert statuses["init"] == "skipped"


@pytest.mark.asyncio
async def test_unknown_step_rejected(tracker):
    with pytest.raises(ValueError):
        await tracker.start_step("nonexistent")


@pytest.mark.asyncio
async def test_terminal_progress_clamps_to_one(tracker, sink):
    await tracker.emit_terminal(status="failed", detail="early death")
    assert sink.events[-1].progress == 1.0
    assert sink.events[-1].terminal is True


@pytest.mark.asyncio
async def test_snapshot_returns_last_state(tracker, sink):
    await tracker.start_step("download")
    snap = tracker.snapshot()
    assert snap["jobId"] == "job"
    assert snap["geometryId"] == "geom"
    assert snap["terminal"] is False
    assert snap["progress"] >= 0.0
