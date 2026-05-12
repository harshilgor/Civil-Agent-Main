"""CivilAgent Column Layout Generator (Agent 3).

The public surface intentionally exposes only:

* :func:`generate_schemes` — deterministic constraint-satisfaction
  algorithm that turns a :class:`ParsedGeometry` (or its JSON shape) into
  4–5 :class:`StructuralScheme` variants.
* The output Pydantic models — the contract surface every downstream
  consumer (worker, API, frontend) reads.
* :data:`GENERATOR_VERSION` — bump when the algorithm changes output for
  a given input.

Anything else is an implementation detail. Do not reach into
``grid_builder``/``constraints``/``beam_builder``/``stacking``/``scoring``
from outside this package.
"""

from packages.engine.column_generator.constants import GENERATOR_VERSION
from packages.engine.column_generator.generator import generate_schemes
from packages.engine.column_generator.models import (
    Beam,
    Brace,
    Column,
    GenerationConstraints,
    Point2D,
    SchemeMetrics,
    ShearWall,
    StructuralScheme,
)

__all__ = [
    "Beam",
    "Brace",
    "Column",
    "GENERATOR_VERSION",
    "GenerationConstraints",
    "Point2D",
    "SchemeMetrics",
    "ShearWall",
    "StructuralScheme",
    "generate_schemes",
]
