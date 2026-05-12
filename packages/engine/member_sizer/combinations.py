"""LRFD load combinations for gravity-only design.

ASCE 7-22 §2.3.1 lists six gravity LRFD combinations. For pure
gravity (no W, no E, no Lr distinction below) only two govern:

    (1) 1.4D
    (2) 1.2D + 1.6L  (or 1.6Lr / 1.6S for roof)

Combination (3) ``1.2D + 1.0L + 1.0Lr`` and the wind/seismic ones
collapse to the above when their non-gravity coefficients are zero.
We deliberately omit the ``1.2D + 1.0L`` combination that some
preliminary tools report — for a pure-gravity beam its demand is
strictly less than ``1.2D + 1.6L`` (linear in L with a smaller
coefficient), so it can never govern. Reporting it adds an audit
trail entry without engineering value, and several reviewers have
flagged that as confusing.

Returned results are always sorted with the governing (highest
demand) combination first.
"""

from __future__ import annotations

from dataclasses import dataclass

from packages.engine.member_sizer.constants import (
    LRFD_GRAVITY_COMBINATIONS,
    LRFD_ROOF_COMBINATIONS,
)


@dataclass(frozen=True)
class LRFDResult:
    name: str
    factored_value: float


def factored_uniform_load(
    w_dead_klf: float,
    w_live_klf: float,
    *,
    is_roof: bool = False,
) -> list[LRFDResult]:
    """Apply LRFD gravity combinations to a beam's per-foot loads.

    Inputs ``w_dead`` and ``w_live`` are in klf. Output values are in
    klf (factored). Sorted descending — caller takes ``[0]`` for the
    governing combo.
    """
    combos = LRFD_ROOF_COMBINATIONS if is_roof else LRFD_GRAVITY_COMBINATIONS
    out: list[LRFDResult] = []
    for combo in combos:
        L_factor = combo.get("L", combo.get("Lr", 0.0))
        wu = combo["D"] * w_dead_klf + L_factor * w_live_klf
        out.append(LRFDResult(name=combo["name"], factored_value=wu))
    out.sort(key=lambda r: r.factored_value, reverse=True)
    return out


def factored_axial_load(
    P_dead_kip: float,
    P_live_kip: float,
) -> list[LRFDResult]:
    """LRFD combinations applied to an axial load (kip).

    Used for column load takedown. Same combinations as the beam
    case — for a column, dead and live are both axial (kip) and the
    output is the factored axial demand.
    """
    out: list[LRFDResult] = []
    for combo in LRFD_GRAVITY_COMBINATIONS:
        Pu = combo["D"] * P_dead_kip + combo.get("L", 0.0) * P_live_kip
        out.append(LRFDResult(name=combo["name"], factored_value=Pu))
    out.sort(key=lambda r: r.factored_value, reverse=True)
    return out


__all__ = [
    "LRFDResult",
    "factored_uniform_load",
    "factored_axial_load",
]
