"""Sanity tests on the shared constant table."""

from __future__ import annotations

import math

from packages.engine.geometry_parser.constants import (
    PARSE_STEPS,
    PARSE_TIMEOUT_SECONDS,
    PARSER_VERSION,
    SCHEMA_VERSION,
    STEP_WEIGHTS,
)


def test_step_weights_sum_to_one():
    assert math.isclose(sum(STEP_WEIGHTS.values()), 1.0, abs_tol=1e-9)


def test_step_weights_cover_all_steps():
    assert set(STEP_WEIGHTS) == set(PARSE_STEPS)


def test_versions_are_strings():
    assert isinstance(PARSER_VERSION, str) and PARSER_VERSION.count(".") == 2
    assert SCHEMA_VERSION.startswith("parsed_geometry@")


def test_timeout_is_positive_int():
    assert isinstance(PARSE_TIMEOUT_SECONDS, int) and PARSE_TIMEOUT_SECONDS > 0
