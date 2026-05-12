"""CivilAgent IFC Geometry Parser package.

The public surface intentionally exposes only:

* :class:`ParsedGeometry` and the related Pydantic models — the canonical
  contract between this service and every downstream agent.
* :func:`parse_file` — the deterministic orchestrator that turns an
  uploaded building file into a :class:`ParsedGeometry`.
* :data:`PARSER_VERSION` and :data:`SCHEMA_VERSION` — the immutable
  identifiers required by the contract / audit trail.
* :mod:`errors` — the structured error taxonomy.

Anything else is an implementation detail. Downstream code MUST NOT
reach into ``formats``/``extractors``/``inference`` directly; those are
private to the parser and may change inside a major version.
"""

from packages.engine.geometry_parser.constants import PARSER_VERSION, SCHEMA_VERSION
from packages.engine.geometry_parser.models import (
    Core,
    ExistingColumn,
    GridLine,
    Level,
    NoColumnZone,
    Opening,
    OriginTransform,
    ParsedGeometry,
    ParseMetadata,
    Point2D,
)
from packages.engine.geometry_parser.parser import parse_file

__all__ = [
    "Core",
    "ExistingColumn",
    "GridLine",
    "Level",
    "NoColumnZone",
    "Opening",
    "OriginTransform",
    "PARSER_VERSION",
    "ParseMetadata",
    "ParsedGeometry",
    "Point2D",
    "SCHEMA_VERSION",
    "parse_file",
]
