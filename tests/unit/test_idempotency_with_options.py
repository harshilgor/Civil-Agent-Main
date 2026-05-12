"""Idempotency key includes parse options.

Two parse triggers for the *same* file but *different* page numbers
must produce different idempotency keys; otherwise page 1 and page 7
of the same drawing set would dedupe against each other and the
engineer would never get the page they asked for.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from packages.engine.geometry_parser.ids import idempotency_key


KW = dict(
    file_sha256="abc123",
    parser_version="1.0.0",
    project_id="proj-1",
)


def test_same_inputs_same_key():
    a = idempotency_key(**KW)
    b = idempotency_key(**KW)
    assert a == b


def test_different_pages_produce_different_keys():
    page_1 = idempotency_key(**KW, options={"pageNumber": 1})
    page_7 = idempotency_key(**KW, options={"pageNumber": 7})
    assert page_1 != page_7


def test_no_options_matches_empty_options():
    """An empty options dict must dedupe with no-options."""
    no_opts = idempotency_key(**KW)
    empty_opts = idempotency_key(**KW, options={})
    none_opts = idempotency_key(**KW, options=None)
    assert no_opts == empty_opts == none_opts


def test_none_values_in_options_are_dropped():
    """``{'pageNumber': None}`` should equal no options at all."""
    none_value = idempotency_key(**KW, options={"pageNumber": None})
    no_opts = idempotency_key(**KW)
    assert none_value == no_opts


def test_force_token_unique_across_calls():
    a = idempotency_key(**KW, force_token="t1")
    b = idempotency_key(**KW, force_token="t2")
    assert a != b


def test_force_token_orthogonal_to_options():
    a = idempotency_key(**KW, options={"pageNumber": 2}, force_token="t1")
    b = idempotency_key(**KW, options={"pageNumber": 2}, force_token="t1")
    c = idempotency_key(**KW, options={"pageNumber": 3}, force_token="t1")
    assert a == b
    assert a != c


def test_options_are_canonical_regardless_of_dict_order():
    """Hashing must be insensitive to dict insertion order."""
    a = idempotency_key(
        **KW, options={"pageNumber": 2, "_future_flag": True}
    )
    b = idempotency_key(
        **KW, options={"_future_flag": True, "pageNumber": 2}
    )
    assert a == b
