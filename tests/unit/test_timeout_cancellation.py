"""Verify that asyncio.wait_for actually cancels CPU-bound extractor work.

Before the to_thread fix, sync ``time.sleep()`` inside an extractor
would hold the event loop and the timeout would never fire. Now the
extractor runs on a worker thread, so the awaiting coroutine *can* be
cancelled — even though the underlying thread keeps running to
completion in the background.

The test confirms two properties:

1. The parser returns within roughly the timeout budget (not the
   sleep duration). We assert ``elapsed < sleep_seconds`` to prove
   wait_for is no longer blocked.
2. The result has ``status == "partial"`` and
   ``failedStepCode == "TIMEOUT"`` and exactly one terminal progress
   event is emitted.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.engine.geometry_parser import parse_file
from packages.engine.geometry_parser.formats import ifc as ifc_mod
from packages.engine.geometry_parser.progress import InMemoryProgressSink
from fixtures import mock_ifc


@pytest.mark.asyncio
async def test_sync_cpu_burn_is_cancellable_via_wait_for(monkeypatch):
    """Sync extractor that sleeps 5s — wait_for(1s) must return promptly."""
    model = mock_ifc.build_known_good_ifc()
    monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
    monkeypatch.setattr(
        ifc_mod,
        "_placement_xy",
        lambda e: (
            float(e.attrs.get("_x", 0.0)),
            float(e.attrs.get("_y", 0.0)),
        ),
    )
    monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    SLEEP_SECONDS = 5.0
    TIMEOUT_SECONDS = 1

    def _hang(*args, **kwargs):
        time.sleep(SLEEP_SECONDS)
        return []

    monkeypatch.setattr(ifc_mod, "_extract_columns", _hang)

    f = tempfile.NamedTemporaryFile(suffix=".ifc", delete=False)
    f.write(b"fake")
    f.close()
    try:
        sink = InMemoryProgressSink()
        start = time.monotonic()
        geometry = await parse_file(
            file_path=f.name,
            run_id="r",
            project_id="p",
            job_id="j",
            geometry_id="g",
            progress_sink=sink,
            timeout_seconds=TIMEOUT_SECONDS,
        )
        elapsed = time.monotonic() - start

        # Properly cancellable: well under the sync sleep duration.
        assert elapsed < SLEEP_SECONDS - 1.0, (
            f"wait_for should cancel within ~{TIMEOUT_SECONDS}s, "
            f"actually waited {elapsed:.2f}s"
        )
        assert geometry.metadata.status == "partial"
        assert geometry.metadata.failedStepCode == "TIMEOUT"

        terminals = [e for e in sink.events if e.terminal]
        assert len(terminals) == 1
        assert terminals[0].status == "timeout"
    finally:
        os.unlink(f.name)


@pytest.mark.asyncio
async def test_orphan_thread_does_not_corrupt_subsequent_parse(monkeypatch):
    """A timeout shouldn't poison the next parse's state."""
    model = mock_ifc.build_known_good_ifc()
    monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
    monkeypatch.setattr(
        ifc_mod,
        "_placement_xy",
        lambda e: (
            float(e.attrs.get("_x", 0.0)),
            float(e.attrs.get("_y", 0.0)),
        ),
    )
    monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    call_count = {"n": 0}

    def _maybe_hang(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            time.sleep(3.0)
        return []

    monkeypatch.setattr(ifc_mod, "_extract_columns", _maybe_hang)

    f = tempfile.NamedTemporaryFile(suffix=".ifc", delete=False)
    f.write(b"fake")
    f.close()
    try:
        # First parse: times out
        sink1 = InMemoryProgressSink()
        g1 = await parse_file(
            file_path=f.name,
            run_id="r1",
            project_id="p",
            job_id="j1",
            geometry_id="g1",
            progress_sink=sink1,
            timeout_seconds=1,
        )
        assert g1.metadata.status == "partial"

        # Second parse: completes (since call_count > 1, no sleep).
        await asyncio.sleep(0.05)
        sink2 = InMemoryProgressSink()
        g2 = await parse_file(
            file_path=f.name,
            run_id="r2",
            project_id="p",
            job_id="j2",
            geometry_id="g2",
            progress_sink=sink2,
            timeout_seconds=10,
        )
        # First parse's run_id must not have leaked.
        assert g2.metadata.runId == "r2"
        assert g1.metadata.runId == "r1"
    finally:
        os.unlink(f.name)
