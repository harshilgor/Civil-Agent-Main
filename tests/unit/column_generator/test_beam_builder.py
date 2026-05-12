"""Unit tests for the beam builder."""

from __future__ import annotations

from packages.engine.column_generator.beam_builder import generate_beams
from packages.engine.column_generator.constraints import build_exclusion_zones


LEVELS = [
    {"id": "L1", "elevation": 0.0},
    {"id": "L2", "elevation": 13.0},
    {"id": "L3", "elevation": 26.0},
]


def _grid(rows, cols):
    return [
        {"id": f"C-{x}-{y}", "x": float(x), "y": float(y),
         "start_level": "L1", "end_level": "L3"}
        for y in rows
        for x in cols
    ]


def test_beams_connect_adjacent_columns():
    cols = _grid(rows=[0, 30], cols=[0, 30, 60])
    beams, _ = generate_beams(cols, LEVELS, exclusion_zones=[], max_bay=30.0)
    # Per-level: 4 horizontal + 3 vertical = 7. Three levels → 21.
    assert len(beams) == 21


def test_beams_dont_pass_through_exclusion_zones():
    cols = _grid(rows=[0, 30], cols=[0, 30, 60])
    # Core spans y=-5..5 → buffered (CORE_BUFFER=3) covers y=-8..8 across x=7..23.
    # The horizontal beam from (0,0)→(30,0) at y=0 must intersect this and be filtered.
    cores = [
        {"id": "CORE", "boundary": [
            {"x": 10, "y": -5}, {"x": 20, "y": -5},
            {"x": 20, "y": 5},  {"x": 10, "y": 5},
        ]},
    ]
    zones = build_exclusion_zones(cores, [], [])
    beams, _ = generate_beams(cols, LEVELS, exclusion_zones=zones, max_bay=30.0)
    for b in beams:
        s, e = b["start"], b["end"]
        if s["y"] == 0 and e["y"] == 0:
            assert not (s["x"] == 0 and e["x"] == 30), \
                "(0,0)→(30,0) crosses buffered core and should have been filtered"


def test_beam_spans_calculated_correctly():
    cols = _grid(rows=[0], cols=[0, 30])
    beams, _ = generate_beams(cols, LEVELS, exclusion_zones=[], max_bay=45.0)
    # One horizontal beam per level → 3 beams.
    assert len(beams) == 3
    for b in beams:
        assert b["span"] == 30.0


def test_beams_generated_at_every_level():
    cols = _grid(rows=[0, 30], cols=[0, 30])
    beams, _ = generate_beams(cols, LEVELS, exclusion_zones=[], max_bay=45.0)
    levels_seen = {b["level_id"] for b in beams}
    assert levels_seen == {"L1", "L2", "L3"}


def test_beam_overlength_emits_warning_but_keeps_beam():
    # Span 35 ft with max_bay=30 ft. Adjacency cutoff is 30*1.2=36 (still
    # connected); overlength threshold is 30*1.1=33 (warns).
    cols = _grid(rows=[0], cols=[0, 35])
    beams, warnings = generate_beams(cols, LEVELS, exclusion_zones=[], max_bay=30.0)
    assert beams, "beams should still be emitted even when overlength"
    assert any("exceeds typical max bay" in w for w in warnings)


def test_no_duplicate_beams_for_same_endpoints():
    cols = [
        {"id": "A", "x": 0.0, "y": 0.0, "start_level": "L1", "end_level": "L1"},
        {"id": "B", "x": 30.0, "y": 0.0, "start_level": "L1", "end_level": "L1"},
        # Same y row + same x column means both adjacency loops would
        # produce the same edge. Make sure we dedupe.
    ]
    levels = [{"id": "L1", "elevation": 0.0}]
    beams, _ = generate_beams(cols, levels, exclusion_zones=[], max_bay=45.0)
    assert len(beams) == 1


def test_columns_outside_level_span_are_excluded():
    cols = [
        {"id": "C-bot", "x": 0.0, "y": 0.0, "start_level": "L1", "end_level": "L1"},
        {"id": "C-bot2", "x": 30.0, "y": 0.0, "start_level": "L1", "end_level": "L1"},
        {"id": "C-top", "x": 0.0, "y": 30.0, "start_level": "L3", "end_level": "L3"},
        {"id": "C-top2", "x": 30.0, "y": 30.0, "start_level": "L3", "end_level": "L3"},
    ]
    beams, _ = generate_beams(cols, LEVELS, exclusion_zones=[], max_bay=45.0)
    # L1 beams should connect only the L1 columns. L3 only L3 columns.
    l1_beams = [b for b in beams if b["level_id"] == "L1"]
    l3_beams = [b for b in beams if b["level_id"] == "L3"]
    l2_beams = [b for b in beams if b["level_id"] == "L2"]
    assert len(l1_beams) == 1
    assert len(l3_beams) == 1
    assert len(l2_beams) == 0
