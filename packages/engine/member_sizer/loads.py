"""Gravity load computation + ASCE 7-22 live load reduction.

This module is the most-scrutinised piece of the entire calculator —
it is the FIRST place a reviewing engineer will look. Every formula
maps directly to a clause in ASCE/SEI 7-22 and is referenced inline.

Conventions:

* Loads on plan in psf (pounds per square foot).
* Linear loads on beams in klf (kips per linear foot).
* Areas in square feet, lengths in feet.
* No lateral/wind/seismic logic lives here — gravity only.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from packages.engine.member_sizer.constants import (
    HEAVY_LIVE_LOAD_PSF,
    LLR_AREA_THRESHOLD_SF,
    LLR_MIN_FACTOR_MULTI_FLOOR,
    LLR_MIN_FACTOR_SINGLE_FLOOR,
)


@dataclass(frozen=True)
class LinearBeamLoad:
    """Per-foot loads on a beam (klf).

    ``self_weight`` is broken out so the iteration loop in the beam
    sizer can reapply the actual W-shape's plf without re-doing the
    LLR + slab DL computation.
    """

    span_ft: float
    trib_width_ft: float
    influence_area_sf: float
    w_dead_slab_klf: float    # slab + MEP dead load (no beam self-weight)
    w_dead_self_klf: float    # beam self-weight contribution
    w_live_unreduced_klf: float
    w_live_reduced_klf: float
    llr_factor: float
    is_roof: bool

    @property
    def w_dead_klf(self) -> float:
        return self.w_dead_slab_klf + self.w_dead_self_klf


# ---------------------------------------------------------------------------
# ASCE 7-22 Section 4.7 — Reduction in uniformly distributed live loads
# ---------------------------------------------------------------------------


def compute_floor_llr_factor(
    live_load_psf: float,
    influence_area_sf: float,
    *,
    floors_supported: int = 1,
) -> float:
    """ASCE 7-22 Eq. 4.7-1.

        L = L0 × (0.25 + 15 / sqrt(K_LL × A_T))

    Returns the reduction multiplier (≤ 1.0). The unreduced live
    load ``L0`` is multiplied by this factor at the call site.

    Constraints (ASCE 7-22 §4.7.2):

    * Reduction is permitted only when ``K_LL × A_T ≥ 400 sf``.
    * No reduction when ``L0 > 100 psf`` (assembly, heavy storage),
      with a narrow exception for storage > 400 sf that we do not
      apply here for office/residential.
    * Lower bound: 0.50 × L0 for members supporting ONE floor, 0.40
      × L0 for members supporting two or more floors. The
      ``floors_supported`` argument selects between them; columns
      pass ``floors_supported = level_count`` accumulated from the
      roof down.

    Implementation note: this function is pure. ``influence_area_sf``
    is the caller's job to compute as ``K_LL × A_T``. Mixing the
    K_LL coefficient inside the formula is the textbook source of
    LLR errors — keeping it outside and letting :mod:`tributary`
    classify position is what makes the calculation auditable.
    """
    if influence_area_sf < LLR_AREA_THRESHOLD_SF:
        return 1.0
    if live_load_psf > HEAVY_LIVE_LOAD_PSF:
        return 1.0

    factor = 0.25 + 15.0 / math.sqrt(influence_area_sf)

    if floors_supported >= 2:
        factor = max(factor, LLR_MIN_FACTOR_MULTI_FLOOR)
    else:
        factor = max(factor, LLR_MIN_FACTOR_SINGLE_FLOOR)

    return min(factor, 1.0)


# ---------------------------------------------------------------------------
# ASCE 7-22 Section 4.8 — Roof live load reduction
# ---------------------------------------------------------------------------


def compute_roof_llr_factor(tributary_area_sf: float, *, rise_per_foot: float = 0.0) -> float:
    """ASCE 7-22 §4.8.2 ordinary flat roofs.

        Lr = L0 × R1 × R2

    where:

    * R1 = 1.0 for A_t ≤ 200 sf
    * R1 = 1.2 - 0.001 × A_t for 200 < A_t < 600
    * R1 = 0.6 for A_t ≥ 600
    * R2 = 1.0 for F ≤ 4 (rise per foot of slope, in inches/ft).
      We default to flat (F=0) — the engineer can override later when
      lateral/cladding agents add roof slope.

    Returns the combined R1 × R2 multiplier in the range [0.6, 1.0].

    The minimum roof live load itself (Lr ≥ 12 psf typical, or 20 psf
    in many jurisdictions) is enforced by the caller via the
    ``DEFAULT_ROOF_LIVE_LOAD_PSF`` assumption — this function only
    handles the area-based reduction.
    """
    A = max(tributary_area_sf, 0.0)
    if A <= 200.0:
        R1 = 1.0
    elif A < 600.0:
        R1 = 1.2 - 0.001 * A
    else:
        R1 = 0.6

    if rise_per_foot <= 4.0:
        R2 = 1.0
    elif rise_per_foot < 12.0:
        R2 = 1.2 - 0.05 * rise_per_foot
    else:
        R2 = 0.6

    factor = R1 * R2
    return max(min(factor, 1.0), 0.4)


# ---------------------------------------------------------------------------
# Convert plan loads → linear loads on beams
# ---------------------------------------------------------------------------


def beam_loads(
    span_ft: float,
    trib_width_ft: float,
    influence_area_sf: float,
    *,
    dead_load_psf: float,
    live_load_psf: float,
    beam_self_weight_plf: float,
    is_roof: bool = False,
    floors_supported: int = 1,
    roof_rise_per_foot: float = 0.0,
) -> LinearBeamLoad:
    """Compute per-foot loads on a beam (kip/ft = klf).

    The slab dead load is ``trib_width × dead_load_psf``, divided by
    1000 to get klf. Beam self-weight is added in plf and divided by
    1000.

    Live load is reduced per ASCE 7-22 §4.7 (floor) or §4.8 (roof)
    using the ``influence_area_sf`` provided by the caller (which
    has already multiplied by the appropriate K_LL).
    """
    span_ft = max(float(span_ft), 0.0)
    trib_width_ft = max(float(trib_width_ft), 0.0)

    w_dead_slab = (dead_load_psf * trib_width_ft) / 1000.0  # klf
    w_dead_self = beam_self_weight_plf / 1000.0             # klf
    w_live_unreduced = (live_load_psf * trib_width_ft) / 1000.0  # klf

    if is_roof:
        llr = compute_roof_llr_factor(
            influence_area_sf / max(1.0, _safe_K_LL_from_influence(influence_area_sf, trib_width_ft, span_ft)),
            rise_per_foot=roof_rise_per_foot,
        )
    else:
        llr = compute_floor_llr_factor(
            live_load_psf,
            influence_area_sf,
            floors_supported=floors_supported,
        )

    w_live_reduced = w_live_unreduced * llr

    return LinearBeamLoad(
        span_ft=span_ft,
        trib_width_ft=trib_width_ft,
        influence_area_sf=influence_area_sf,
        w_dead_slab_klf=w_dead_slab,
        w_dead_self_klf=w_dead_self,
        w_live_unreduced_klf=w_live_unreduced,
        w_live_reduced_klf=w_live_reduced,
        llr_factor=llr,
        is_roof=is_roof,
    )


def _safe_K_LL_from_influence(
    influence_area_sf: float, trib_width_ft: float, span_ft: float
) -> float:
    """Recover the K_LL value the caller used.

    Used only by the roof path so we can pass ``A_T`` (not the
    influence area) to ``compute_roof_llr_factor`` — the roof
    reduction formula uses tributary area, not influence area.
    """
    A_T = trib_width_ft * span_ft
    if A_T <= 0:
        return 1.0
    return max(influence_area_sf / A_T, 1.0)


__all__ = [
    "LinearBeamLoad",
    "beam_loads",
    "compute_floor_llr_factor",
    "compute_roof_llr_factor",
]
