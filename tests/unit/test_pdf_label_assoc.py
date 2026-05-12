"""Vector PDF grid-label association + multi-page handling.

We don't ship a real fixture PDF (binary blob churn would dominate
diffs); instead we drive the helpers directly with the same shape of
data PyMuPDF returns. This exercises the *logic* — the PyMuPDF
integration itself is covered by the smoke parse path.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.engine.geometry_parser.formats.pdf import (
    LABEL_ASSOC_RADIUS_PT,
    _associate_label,
    _looks_like_grid_label,
    _normalize_page_number,
)


# ---------------------------------------------------------------------------
# _looks_like_grid_label
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "label, expected",
    [
        ("A", True),
        ("AA", True),
        ("1", True),
        ("12", True),
        ("3.1", True),
        ("99", True),
        # Things we should reject:
        ("hello", False),
        ("", False),
        ("ABCDEF", False),
        ("3,000", False),  # comma decimal — locale weird, drop it
    ],
)
def test_grid_label_classifier(label, expected):
    assert _looks_like_grid_label(label) is expected


# ---------------------------------------------------------------------------
# _associate_label
# ---------------------------------------------------------------------------


def test_label_picked_from_nearest_text():
    texts = [
        ("A", 100.0, 100.0),  # close to first endpoint
        ("nope", 999.0, 999.0),  # too far away to consider
        ("B", 102.0, 102.0),  # also close, slightly farther
    ]
    endpoints = [(101.0, 101.0), (101.0, 500.0)]  # vertical line
    label, conf = _associate_label(texts, endpoints, axis="x")
    assert label == "A"
    assert conf > 0.9  # very close


def test_returns_none_when_no_text_within_radius():
    texts = [("A", 9999.0, 9999.0)]
    endpoints = [(0.0, 0.0), (0.0, 100.0)]
    label, conf = _associate_label(texts, endpoints, axis="x")
    assert label is None
    assert conf == 0.0


def test_rejects_text_that_doesnt_look_like_a_label():
    texts = [("description", 0.5, 0.5)]
    endpoints = [(0.0, 0.0), (0.0, 100.0)]
    label, conf = _associate_label(texts, endpoints, axis="x")
    assert label is None


def test_radius_boundary_is_inclusive_for_close_matches():
    just_outside = LABEL_ASSOC_RADIUS_PT + 1.0
    just_inside = LABEL_ASSOC_RADIUS_PT - 1.0
    endpoints = [(0.0, 0.0), (0.0, 100.0)]
    assert _associate_label(
        [("A", just_outside, 0.0)], endpoints, axis="x"
    )[0] is None
    assert _associate_label(
        [("A", just_inside, 0.0)], endpoints, axis="x"
    )[0] == "A"


# ---------------------------------------------------------------------------
# _normalize_page_number
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        (None, None),
        (1, 1),
        ("3", 3),
        (0, None),
        (-2, None),
        ("not-a-number", None),
        (1.5, 1),
    ],
)
def test_normalize_page_number(raw, expected):
    assert _normalize_page_number(raw) == expected
