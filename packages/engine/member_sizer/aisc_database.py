"""AISC W-shape section property lookup + selection.

The static JSON in ``data/aisc_w_shapes.json`` carries verified
section properties from the AISC Steel Construction Manual (16th ed.).
This module loads that file once at import time and provides:

* ``get_shape(name)`` — exact lookup by canonical name (e.g. "W21x44").
* ``find_lightest_beam(required_Zx, max_depth_in)`` — beam selection
  by plastic section modulus, sorted by weight ascending.
* ``column_capacity(shape, KL_ft, fy, e)`` — AISC 360 Chapter E flexural
  buckling capacity.
* ``find_lightest_column(required_Pn, KL_ft, ...)`` — column selection
  preferring the W14 series (industry workhorse), falling back to
  W12/W10.
* ``get_section_depth(name)`` — nominal depth from the size name.

All numbers are deterministic. The module never makes a network call,
never reads the database, and never references the project state.
That keeps it usable in pure-Python tests and inside the engine's
sandbox without cross-process dependencies.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

from packages.engine.member_sizer.constants import (
    BEAM_DEPTH_CEILING_IN,
    COLUMN_SERIES_PREFERENCE,
    DEFAULT_E_KSI,
    DEFAULT_FY_KSI,
    PHI_COMPRESSION,
)


_DATA_PATH = Path(__file__).parent / "data" / "aisc_w_shapes.json"


@dataclass(frozen=True)
class WShape:
    """Immutable view of a single W-shape's properties.

    Attribute names mirror the JSON keys. Units are AISC standard:

    * lengths in inches (``d``, ``bf``, ``tf``, ``tw``);
    * areas in square inches (``A``);
    * moments of inertia in inches⁴ (``Ix``, ``Iy``);
    * section moduli in inches³ (``Sx``, ``Zx``);
    * radii of gyration in inches (``rx``, ``ry``);
    * weight in pounds per linear foot (``weight_plf``).
    """

    name: str
    nominal_depth: int
    weight_plf: float
    d: float
    bf: float
    tf: float
    tw: float
    A: float
    Ix: float
    Iy: float
    Sx: float
    Zx: float
    rx: float
    ry: float

    @property
    def Aw(self) -> float:
        """Web area for AISC G2 shear: Aw = d * tw."""
        return self.d * self.tw


@lru_cache(maxsize=1)
def _load_shapes() -> tuple[WShape, ...]:
    """Load the JSON file once. Returns shapes sorted by weight."""
    with _DATA_PATH.open("r", encoding="utf-8") as fp:
        raw = json.load(fp)
    shapes = tuple(
        WShape(
            name=s["name"],
            nominal_depth=int(s["nominal_depth"]),
            weight_plf=float(s["weight_plf"]),
            d=float(s["d"]),
            bf=float(s["bf"]),
            tf=float(s["tf"]),
            tw=float(s["tw"]),
            A=float(s["A"]),
            Ix=float(s["Ix"]),
            Iy=float(s["Iy"]),
            Sx=float(s["Sx"]),
            Zx=float(s["Zx"]),
            rx=float(s["rx"]),
            ry=float(s["ry"]),
        )
        for s in raw["shapes"]
    )
    if not shapes:
        raise RuntimeError("AISC database is empty.")
    # Sort by weight ascending — beam/column selection walks lightest-first.
    return tuple(sorted(shapes, key=lambda s: s.weight_plf))


def _by_name() -> dict[str, WShape]:
    return {s.name: s for s in _load_shapes()}


# ---------------------------------------------------------------------------
# Public lookup
# ---------------------------------------------------------------------------


def get_shape(name: str) -> Optional[WShape]:
    """Return the WShape matching ``name`` exactly, or ``None``.

    Names are case-insensitive and tolerate "W21x44" / "W21X44" /
    "w21x44" — the canonical form is "W{depth}x{weight}" lowercase x.
    """
    if not name:
        return None
    canonical = _canonical_name(name)
    return _by_name().get(canonical)


def get_section_depth(name: str) -> float:
    """Nominal depth in inches inferred from the section name.

    Falls back to the actual ``d`` if the name cannot be parsed.
    """
    if not name:
        return 0.0
    m = re.match(r"^[Ww](\d+)[xX](\d+)", name.strip())
    if m:
        return float(m.group(1))
    shape = get_shape(name)
    return shape.d if shape else 0.0


def get_all_shapes_sorted_by_weight() -> tuple[WShape, ...]:
    """All shapes, lightest first."""
    return _load_shapes()


def shapes_in_series(series: str) -> tuple[WShape, ...]:
    """Filter shapes whose name starts with the given series prefix.

    Example: ``shapes_in_series("W14")`` returns every W14 in the
    database, sorted lightest-first.
    """
    prefix = series.upper().rstrip("xX")
    return tuple(s for s in _load_shapes() if s.name.upper().startswith(prefix + "X"))


# ---------------------------------------------------------------------------
# Beam selection
# ---------------------------------------------------------------------------


def find_lightest_beam(
    required_Zx: float,
    max_depth_in: Optional[float] = None,
    *,
    candidates: Optional[Iterable[WShape]] = None,
) -> Optional[WShape]:
    """Lightest W-shape with ``Zx >= required_Zx``.

    Optionally constrained by maximum depth (used for "short span"
    schemes that want shallow framing). Returns ``None`` if nothing
    satisfies the constraints.
    """
    if required_Zx <= 0:
        # Caller probably passed a degenerate input — return the
        # lightest small beam so the result chain stays valid.
        return _by_name().get("W8x10")

    cap = max_depth_in if max_depth_in is not None else BEAM_DEPTH_CEILING_IN
    pool = candidates if candidates is not None else _load_shapes()

    for shape in pool:
        if shape.d > cap:
            continue
        if shape.Zx >= required_Zx:
            return shape
    return None


# ---------------------------------------------------------------------------
# Column capacity (AISC 360 Chapter E)
# ---------------------------------------------------------------------------


def column_capacity(
    shape: WShape,
    KL_ft: float,
    *,
    fy_ksi: float = DEFAULT_FY_KSI,
    e_ksi: float = DEFAULT_E_KSI,
) -> tuple[float, float]:
    """Compute φPn (kip) and slenderness KL/r for a W-shape column.

    Implements AISC 360-22 Chapter E (Eqs. E3-1, E3-2, E3-3, E3-4):

    * ``Fe = π² E / (KL/r)²``     elastic critical stress
    * If ``KL/r ≤ 4.71 √(E/Fy)``: inelastic regime
        ``Fcr = (0.658^(Fy/Fe)) × Fy``
    * Else (slender): elastic regime
        ``Fcr = 0.877 × Fe``
    * ``φPn = φc × Fcr × A``       (φc = 0.90)

    Uses ``r_y`` (weak-axis radius of gyration) — conservative for
    gravity-only design where lateral bracing is not yet checked.

    Returns ``(phi_Pn_kip, slenderness)``.
    """
    if KL_ft <= 0 or shape.ry <= 0:
        return 0.0, 0.0
    KL_in = KL_ft * 12.0
    slenderness = KL_in / shape.ry

    if slenderness <= 0:
        return 0.0, 0.0

    Fe = (math.pi ** 2 * e_ksi) / (slenderness ** 2)
    threshold = 4.71 * math.sqrt(e_ksi / fy_ksi)

    if slenderness <= threshold:
        # Inelastic buckling — capped exponent to avoid floating
        # point silliness when Fe → ∞ (very small KL/r).
        ratio = fy_ksi / Fe
        Fcr = (0.658 ** ratio) * fy_ksi
    else:
        Fcr = 0.877 * Fe

    phi_Pn = PHI_COMPRESSION * Fcr * shape.A
    return phi_Pn, slenderness


def find_lightest_column(
    required_phi_Pn: float,
    KL_ft: float,
    *,
    fy_ksi: float = DEFAULT_FY_KSI,
    e_ksi: float = DEFAULT_E_KSI,
    preferred_series: tuple[str, ...] = COLUMN_SERIES_PREFERENCE,
) -> Optional[WShape]:
    """Lightest W-shape column that meets the required φPn at KL.

    Walks each series in ``preferred_series`` (default: W14 → W12 →
    W10) and within a series the lightest shape is tried first. The
    first shape with ``φPn >= required`` wins. If no shape in any
    series qualifies, returns ``None``.

    The W14 family covers ~95% of routine office/residential column
    loads up to 30 stories at typical bay sizes; falling through to
    W12/W10 only happens when bay sizes shrink below ~25 ft.
    """
    if required_phi_Pn <= 0:
        # Fall back to a small column rather than returning None — the
        # rest of the pipeline expects a shape.
        return get_shape("W14x22") or get_shape("W10x33")

    for series in preferred_series:
        for shape in shapes_in_series(series):
            phi_Pn, _ = column_capacity(
                shape, KL_ft, fy_ksi=fy_ksi, e_ksi=e_ksi
            )
            if phi_Pn >= required_phi_Pn:
                return shape

    # Last-ditch: try every shape in the database. Useful only for
    # absurdly tall columns / heavy loads where the preferred series
    # aren't enough.
    for shape in _load_shapes():
        phi_Pn, _ = column_capacity(
            shape, KL_ft, fy_ksi=fy_ksi, e_ksi=e_ksi
        )
        if phi_Pn >= required_phi_Pn:
            return shape

    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _canonical_name(raw: str) -> str:
    """Normalise "W21X44" / "W21x44" / "w21x44" to the canonical form
    used in the JSON database (lowercase x).

    Other separators (e.g. "W21X44.0") are tolerated by ignoring
    trailing decimals on the weight.
    """
    s = raw.strip()
    m = re.match(r"^[Ww](\d+)[xX](\d+)(?:\.\d+)?$", s)
    if m:
        return f"W{m.group(1)}x{m.group(2)}"
    return s  # fall through — caller will get None if unmatched


__all__ = [
    "WShape",
    "get_shape",
    "get_section_depth",
    "get_all_shapes_sorted_by_weight",
    "shapes_in_series",
    "find_lightest_beam",
    "column_capacity",
    "find_lightest_column",
]
