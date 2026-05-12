"""Orchestrator-level tests:

* Always returns a result, never raises (failure containment).
* Emits exactly one terminal progress event regardless of path.
* Timeout path returns a partial result.
* Unknown extension is captured as a structured failure.
* Determinism: identical input produces identical output (excluding
  ``runId`` / ``parsedAt``).
"""

from __future__ import annotations

from typing import Any

import pytest

from packages.engine.geometry_parser import parse_file
from packages.engine.geometry_parser.errors import ErrorCode
from packages.engine.geometry_parser.formats import ifc as ifc_mod
from packages.engine.geometry_parser.models import ParsedGeometry
from packages.engine.geometry_parser.progress import InMemoryProgressSink
from tests.fixtures import mock_ifc


@pytest.fixture
def fake_ifc_file(tmp_path) -> str:
    p = tmp_path / "synthetic.ifc"
    p.write_text("ISO-10303-21;\nHEADER;\n/* fake content */\nENDSEC;\n")
    return str(p)


# ---------------------------------------------------------------------------
# Test 1 — gold path through the IFC pipeline (mocked model)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_clean_ifc_with_grid_high_confidence(monkeypatch, fake_ifc_file, in_memory_progress_sink):
    model = mock_ifc.build_known_good_ifc()
    monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
    monkeypatch.setattr(
        ifc_mod, "_placement_xy",
        lambda e: (float(e.attrs.get("_x", 0.0)), float(e.attrs.get("_y", 0.0))),
    )
    monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    result: ParsedGeometry = await parse_file(
        file_path=fake_ifc_file,
        run_id="run-1",
        project_id="proj-1",
        job_id="job-1",
        geometry_id="geom-1",
        progress_sink=in_memory_progress_sink,
        timeout_seconds=30,
    )

    assert result.metadata.status == "completed"
    assert result.metadata.failedStep is None
    assert result.metadata.parserVersion == "1.0.0"
    assert result.metadata.schemaVersion == "parsed_geometry@1.0.0"
    assert len(result.levels) == 8
    assert result.gridLines, "grid lines must come from IfcGrid"
    assert all(g.source == "ifc" for g in result.gridLines)
    assert result.existingColumns, "columns must be parsed"
    assert result.metadata.overallConfidence >= 0.6
    terminal = [e for e in in_memory_progress_sink.events if e.terminal]
    assert len(terminal) == 1 and terminal[0].status == "completed"


# ---------------------------------------------------------------------------
# Test 2 — IFC without IfcGrid → inference + downgraded confidence
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ifc_without_grid_runs_inference(monkeypatch, fake_ifc_file, in_memory_progress_sink):
    model = mock_ifc.build_ifc_no_grid()
    monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
    monkeypatch.setattr(
        ifc_mod, "_placement_xy",
        lambda e: (float(e.attrs.get("_x", 0.0)), float(e.attrs.get("_y", 0.0))),
    )
    monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    result = await parse_file(
        file_path=fake_ifc_file,
        run_id="run-2", project_id="proj-2", job_id="job-2", geometry_id="geom-2",
        progress_sink=in_memory_progress_sink, timeout_seconds=30,
    )
    assert result.metadata.status == "completed"
    assert result.gridLines, "grids should be inferred"
    assert all(g.source == "inferred" for g in result.gridLines)
    assert any("inferred from column positions" in w for w in result.metadata.warnings)


# ---------------------------------------------------------------------------
# Test 3 — off-grid columns get gridAligned=False
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_offgrid_columns_flagged(monkeypatch, fake_ifc_file, in_memory_progress_sink):
    model = mock_ifc.build_offgrid_ifc()
    monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
    monkeypatch.setattr(
        ifc_mod, "_placement_xy",
        lambda e: (float(e.attrs.get("_x", 0.0)), float(e.attrs.get("_y", 0.0))),
    )
    monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    result = await parse_file(
        file_path=fake_ifc_file,
        run_id="r", project_id="p", job_id="j", geometry_id="g",
        progress_sink=in_memory_progress_sink, timeout_seconds=30,
    )
    misaligned = [c for c in result.existingColumns if c.gridAligned is False]
    assert misaligned, "expected at least one off-grid column"
    assert all(c.gridDeviation is not None for c in misaligned)


# ---------------------------------------------------------------------------
# Test 4 — architectural-only IFC (no IfcColumn)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_architectural_only_ifc_returns_warning(monkeypatch, fake_ifc_file, in_memory_progress_sink):
    model = mock_ifc.build_ifc_no_columns()
    monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
    monkeypatch.setattr(
        ifc_mod, "_placement_xy",
        lambda e: (float(e.attrs.get("_x", 0.0)), float(e.attrs.get("_y", 0.0))),
    )
    monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    result = await parse_file(
        file_path=fake_ifc_file,
        run_id="r", project_id="p", job_id="j", geometry_id="g",
        progress_sink=in_memory_progress_sink, timeout_seconds=30,
    )
    assert result.existingColumns == []
    assert any("IFC_NO_STRUCTURAL_ELEMENTS" in w for w in result.metadata.warnings)


# ---------------------------------------------------------------------------
# Test 5 — invalid file path → failed status, no exception
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_file_returns_failed(in_memory_progress_sink):
    result = await parse_file(
        file_path="/does/not/exist.ifc",
        run_id="r", project_id="p", job_id="j", geometry_id="g",
        progress_sink=in_memory_progress_sink, timeout_seconds=5,
    )
    assert result.metadata.status == "failed"
    assert result.metadata.failedStep == "download"
    assert result.metadata.failedStepCode == ErrorCode.FILE_NOT_FOUND.value
    terminal = [e for e in in_memory_progress_sink.events if e.terminal]
    assert len(terminal) == 1 and terminal[0].status == "failed"


# ---------------------------------------------------------------------------
# Test 6 — unsupported extension → structured failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unsupported_extension(in_memory_progress_sink, tmp_path):
    p = tmp_path / "drawing.txt"
    p.write_text("not a building")
    result = await parse_file(
        file_path=str(p),
        run_id="r", project_id="p", job_id="j", geometry_id="g",
        progress_sink=in_memory_progress_sink, timeout_seconds=5,
    )
    assert result.metadata.status == "failed"
    assert result.metadata.failedStepCode == ErrorCode.UNSUPPORTED_FORMAT.value


# ---------------------------------------------------------------------------
# Test 7 — global timeout returns partial result + terminal event
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_returns_partial(monkeypatch, fake_ifc_file, in_memory_progress_sink):
    """Patch the format extractor with a slow *cooperative* coroutine so
    ``asyncio.wait_for`` can deliver cancellation. (CPU-blocking sync
    code is intentionally outside the orchestrator's timeout contract;
    we run such extractors in a thread pool when added.)
    """
    import asyncio as _asyncio

    async def _slow_extract(**_kwargs):
        await _asyncio.sleep(5.0)
        # Should never reach here within timeout=1.
        raise AssertionError("timeout did not cancel slow extractor")

    monkeypatch.setattr(ifc_mod, "extract_ifc", _slow_extract)

    result = await parse_file(
        file_path=fake_ifc_file,
        run_id="r", project_id="p", job_id="j", geometry_id="g",
        progress_sink=in_memory_progress_sink,
        timeout_seconds=1,
    )
    assert result.metadata.status in {"partial", "failed"}
    assert result.metadata.failedStepCode == "TIMEOUT"
    terminal = [e for e in in_memory_progress_sink.events if e.terminal]
    assert len(terminal) == 1
    assert terminal[0].status == "timeout"


# ---------------------------------------------------------------------------
# Test 8 — determinism: same input produces same output
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_deterministic_output(monkeypatch, fake_ifc_file):
    def _setup():
        model = mock_ifc.build_known_good_ifc()
        monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)
        monkeypatch.setattr(
            ifc_mod, "_placement_xy",
            lambda e: (float(e.attrs.get("_x", 0.0)), float(e.attrs.get("_y", 0.0))),
        )
        monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    _setup()
    sink_a = InMemoryProgressSink()
    a = await parse_file(
        file_path=fake_ifc_file, run_id="run-A", project_id="p",
        job_id="j", geometry_id="g", progress_sink=sink_a, timeout_seconds=30,
    )
    _setup()
    sink_b = InMemoryProgressSink()
    b = await parse_file(
        file_path=fake_ifc_file, run_id="run-B", project_id="p",
        job_id="j2", geometry_id="g2", progress_sink=sink_b, timeout_seconds=30,
    )
    a_blob = _scrub(a)
    b_blob = _scrub(b)
    assert a_blob == b_blob


def _scrub(g: ParsedGeometry) -> dict[str, Any]:
    """Drop fields that are explicitly non-deterministic per the contract."""
    blob = g.model_dump(mode="json")
    blob["metadata"].pop("runId", None)
    blob["metadata"].pop("parsedAt", None)
    blob["metadata"].pop("durationMs", None)
    blob["metadata"].pop("sourceFileId", None)
    return blob
