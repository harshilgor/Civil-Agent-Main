"""Determinism tests on the ID helpers."""

from __future__ import annotations

import os
import tempfile

from packages.engine.geometry_parser.ids import (
    column_id,
    file_hash,
    grid_id,
    idempotency_key,
    level_id,
    stable_dump,
)


def test_level_id_is_deterministic():
    assert level_id("Level 1", 0.0) == level_id("Level 1", 0.0)
    assert level_id("Level 1", 0.0) != level_id("Level 1", 14.0)


def test_grid_id_changes_with_axis():
    assert grid_id("x", "1", 0.0) != grid_id("y", "1", 0.0)


def test_column_id_rounds_floats_consistently():
    a = column_id(1.000001, 2.0, "lvl_1")
    b = column_id(1.0000010001, 2.0000004999, "lvl_1")
    assert a == b


def test_file_hash_stable():
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(b"hello civilagent\n")
        path = f.name
    try:
        assert file_hash(path) == file_hash(path)
        assert len(file_hash(path)) == 64
    finally:
        os.unlink(path)


def test_idempotency_key_changes_with_parser_version():
    a = idempotency_key(file_sha256="a" * 64, parser_version="1.0.0", project_id="p")
    b = idempotency_key(file_sha256="a" * 64, parser_version="1.1.0", project_id="p")
    assert a != b


def test_idempotency_key_force_token_makes_unique():
    a = idempotency_key(file_sha256="a", parser_version="1", project_id="p")
    b = idempotency_key(file_sha256="a", parser_version="1", project_id="p", force_token="x")
    assert a != b


def test_stable_dump_sorts_keys():
    a = stable_dump({"b": 1, "a": 2})
    b = stable_dump({"a": 2, "b": 1})
    assert a == b
