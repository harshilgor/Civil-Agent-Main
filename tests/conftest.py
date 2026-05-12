"""Pytest fixtures + path setup."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

# Make sure tests don't accidentally hit a real database / Redis / S3.
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/15")
os.environ.setdefault("S3_ENDPOINT_URL", "http://localhost:4566")
os.environ.setdefault("S3_BUCKET", "civilagent-test")
os.environ.setdefault("AUTH_DEV_BYPASS", "true")
os.environ.setdefault("PARSE_TIMEOUT_SECONDS", "60")
os.environ.setdefault("ANTHROPIC_API_KEY", "")


@pytest.fixture(autouse=True)
def _reset_settings_cache():
    """Drop the lru_cache between tests so env-var fiddling takes effect."""
    from apps.api.core.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def synthetic_ifc(tmp_path) -> str:
    pytest.importorskip("ifcopenshell")
    from tests.fixtures.synthetic_ifc import write_fixture

    return write_fixture(str(tmp_path))


@pytest.fixture
def in_memory_progress_sink():
    from packages.engine.geometry_parser.progress import InMemoryProgressSink

    return InMemoryProgressSink()


@pytest.fixture
def patched_ifc_loader(monkeypatch):
    """Return a callable that registers a FakeModel as the loader output."""
    from tests.fixtures import mock_ifc

    def _install(model) -> None:
        from packages.engine.geometry_parser.formats import ifc as ifc_mod

        monkeypatch.setattr(ifc_mod, "_open_ifc", lambda path: model)

        # Replace placement reader with our duck-typed lookup.
        def _placement_xy(entity):
            return float(entity.attrs.get("_x", 0.0)), float(entity.attrs.get("_y", 0.0))

        monkeypatch.setattr(ifc_mod, "_placement_xy", _placement_xy)

        # Avoid IfcOpenShell geometry lib for slabs.
        monkeypatch.setattr(ifc_mod, "_slab_footprint", lambda slab: [])

    yield _install
