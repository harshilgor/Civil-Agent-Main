"""Beam sizing — flexure, shear, and deflection per AISC 360-22.

For each beam:

1. Compute Mu (factored moment) and Vu (factored shear) from a
   simply-supported beam under uniform load.
2. Find the lightest W-shape with sufficient Zx for flexure.
3. Verify shear capacity at the selected size; iterate up if needed.
4. Verify live-load and total-load deflection; iterate up if needed.
5. Iterate on self-weight: re-run with the actual section's plf if
   it differs materially from the assumed self-weight.

Assumptions (every one is documented in the per-check ``explanation``
so engineers can audit them):

* Simply supported (pinned-pinned) — conservative for continuous
  framing where the negative-moment regions can be smaller.
* Uniform distributed load — concentrated MEP / equipment loads are
  out of scope.
* Lb ≤ Lp (compression flange continuously braced by the deck) —
  φMn = φMp = φ × Fy × Zx. We emit a warning for spans > 25 ft so
  the engineer can verify the bracing assumption explicitly.
* Bare steel, non-composite. Composite action would reduce sizes;
  this is conservative.
* No coped connections, no web openings.
* Cv1 = 1.0 (web yielding governs shear for all standard W-shapes
  with h/tw ≤ 2.24√(E/Fy) ≈ 53.9, which covers every shape in our
  database).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Iterable, Optional

from packages.engine.member_sizer.aisc_database import (
    WShape,
    find_lightest_beam,
    get_all_shapes_sorted_by_weight,
)
from packages.engine.member_sizer.combinations import (
    LRFDResult,
    factored_uniform_load,
)
from packages.engine.member_sizer.constants import (
    BEAM_DEPTH_CEILING_IN,
    BEAM_LIVE_DEFLECTION_LIMIT,
    BEAM_TOTAL_DEFLECTION_LIMIT,
    DEFAULT_E_KSI,
    DEFAULT_FY_KSI,
    LONG_BEAM_WARN_THRESHOLD_FT,
    PHI_FLEXURE,
    PHI_SHEAR,
    ROOF_LIVE_DEFLECTION_LIMIT,
    SELF_WEIGHT_RELATIVE_TOLERANCE,
    dcr_to_status,
)
from packages.engine.member_sizer.loads import LinearBeamLoad
from packages.engine.member_sizer.models import MemberCheck, MemberSizingSummary


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BeamSizingInputs:
    """Caller-supplied data for a single beam sizing pass."""

    scheme_id: str
    beam_id: str
    loads: LinearBeamLoad             # already includes LLR
    fy_ksi: float = DEFAULT_FY_KSI
    e_ksi: float = DEFAULT_E_KSI
    live_deflection_denom: float = 360.0
    total_deflection_denom: float = 240.0
    max_depth_in: float = BEAM_DEPTH_CEILING_IN


def size_beam(inputs: BeamSizingInputs) -> MemberSizingSummary:
    """Select the lightest W-shape that passes flexure + shear +
    deflection, or report failure if none qualifies.

    Performs at most two passes — first with the caller's assumed
    self-weight, second with the actual selected section's plf if it
    differs by more than :data:`SELF_WEIGHT_RELATIVE_TOLERANCE`.
    """
    span_ft = inputs.loads.span_ft

    # Pass 1: use the supplied loads as-is.
    summary = _select_and_check(inputs, inputs.loads)

    # Pass 2: refine self-weight if a section was selected.
    actual_plf = _shape_weight_plf(summary.selected_size)
    assumed_plf = inputs.loads.w_dead_self_klf * 1000.0
    if (
        actual_plf > 0
        and assumed_plf > 0
        and abs(actual_plf - assumed_plf) / assumed_plf
        > SELF_WEIGHT_RELATIVE_TOLERANCE
    ):
        # Build a refreshed load record with the actual self-weight.
        refined = LinearBeamLoad(
            span_ft=inputs.loads.span_ft,
            trib_width_ft=inputs.loads.trib_width_ft,
            influence_area_sf=inputs.loads.influence_area_sf,
            w_dead_slab_klf=inputs.loads.w_dead_slab_klf,
            w_dead_self_klf=actual_plf / 1000.0,
            w_live_unreduced_klf=inputs.loads.w_live_unreduced_klf,
            w_live_reduced_klf=inputs.loads.w_live_reduced_klf,
            llr_factor=inputs.loads.llr_factor,
            is_roof=inputs.loads.is_roof,
        )
        summary = _select_and_check(inputs, refined)

    # Long-beam warning — surfaces the Lb ≤ Lp assumption.
    if span_ft > LONG_BEAM_WARN_THRESHOLD_FT:
        summary.warnings.append(
            f"Span {span_ft:.0f} ft exceeds {LONG_BEAM_WARN_THRESHOLD_FT:.0f} ft — "
            "verify continuous bracing of the compression flange (Lb ≤ Lp). "
            "MVP assumes deck provides full bracing; without it, lateral-"
            "torsional buckling may govern."
        )

    return summary


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _select_and_check(
    inputs: BeamSizingInputs, loads: LinearBeamLoad
) -> MemberSizingSummary:
    """One pass of select-and-verify. Mutates nothing."""
    span_ft = loads.span_ft
    fy = inputs.fy_ksi
    e_ksi = inputs.e_ksi

    # Governing factored uniform load (klf).
    factored = factored_uniform_load(
        loads.w_dead_klf, loads.w_live_reduced_klf, is_roof=loads.is_roof
    )
    governing = factored[0]
    Mu_kip_ft = governing.factored_value * (span_ft ** 2) / 8.0    # kip-ft
    Vu_kip = governing.factored_value * span_ft / 2.0              # kip

    # ----- Flexure: required Zx -----
    # φMn (kip-ft) = φ × Fy (ksi) × Zx (in³) / 12  →  Zx_req = Mu × 12 / (φ × Fy)
    Zx_required = (Mu_kip_ft * 12.0) / (PHI_FLEXURE * fy) if Mu_kip_ft > 0 else 0.0

    # Walk lightest-first for flexure, then verify shear + deflection at
    # each candidate. Upgrade if a check fails.
    selected = _find_passing_shape(
        Zx_required=Zx_required,
        Vu_kip=Vu_kip,
        loads=loads,
        fy=fy,
        e_ksi=e_ksi,
        live_denom=inputs.live_deflection_denom,
        total_denom=inputs.total_deflection_denom,
        max_depth_in=inputs.max_depth_in,
    )

    if selected is None:
        # No passing shape — fall back to the deepest available so the
        # member at least has a name in the database. The check will
        # still report fail.
        selected = _deepest_in_pool(inputs.max_depth_in) or _fallback_shape()

    return _build_summary(
        scheme_id=inputs.scheme_id,
        beam_id=inputs.beam_id,
        shape=selected,
        loads=loads,
        Mu_kip_ft=Mu_kip_ft,
        Vu_kip=Vu_kip,
        governing_combination=governing,
        fy=fy,
        e_ksi=e_ksi,
        live_denom=inputs.live_deflection_denom,
        total_denom=inputs.total_deflection_denom,
    )


def _find_passing_shape(
    *,
    Zx_required: float,
    Vu_kip: float,
    loads: LinearBeamLoad,
    fy: float,
    e_ksi: float,
    live_denom: float,
    total_denom: float,
    max_depth_in: float,
) -> Optional[WShape]:
    """Walk the database lightest-first, return first shape that
    passes flexure + shear + deflection.

    Selection is by ``Zx`` first, then we enforce shear and
    deflection by upgrading the candidate. The deflection check is
    where deep beams matter — for long spans ``Ix`` rises with depth
    so a heavier light-flanged section may still fail deflection
    where a deeper one passes. We therefore iterate over the entire
    sorted-by-weight list rather than relying on Zx alone.
    """
    L_in = loads.span_ft * 12.0
    if L_in <= 0:
        return None

    w_live_kip_per_in = loads.w_live_reduced_klf / 12.0
    w_total_kip_per_in = loads.w_dead_klf / 12.0 + w_live_kip_per_in

    for shape in get_all_shapes_sorted_by_weight():
        if shape.d > max_depth_in:
            continue

        # Flexure
        if shape.Zx < Zx_required:
            continue

        # Shear
        phi_Vn = PHI_SHEAR * 0.6 * fy * shape.Aw  # kip
        if phi_Vn < Vu_kip:
            continue

        # Deflection (service loads, NOT factored)
        I = shape.Ix
        if I <= 0:
            continue
        delta_live = (5.0 * w_live_kip_per_in * (L_in ** 4)) / (384.0 * e_ksi * I)
        delta_allow_live = L_in / live_denom
        if delta_live > delta_allow_live:
            continue
        delta_total = (5.0 * w_total_kip_per_in * (L_in ** 4)) / (384.0 * e_ksi * I)
        delta_allow_total = L_in / total_denom
        if delta_total > delta_allow_total:
            continue

        return shape

    # No shape passed every check — try a flexure-only fallback so we
    # at least produce a non-empty result. The deflection check will
    # then report a failure DCR > 1.0.
    return find_lightest_beam(Zx_required, max_depth_in)


def _deepest_in_pool(max_depth_in: float) -> Optional[WShape]:
    """Return the deepest shape we know of (under cap)."""
    best: Optional[WShape] = None
    for s in get_all_shapes_sorted_by_weight():
        if s.d > max_depth_in:
            continue
        if best is None or s.d > best.d:
            best = s
    return best


def _fallback_shape() -> Optional[WShape]:
    """Lightest possible — used only when the pool is empty."""
    pool = get_all_shapes_sorted_by_weight()
    return pool[0] if pool else None


def _shape_weight_plf(name: str) -> float:
    from packages.engine.member_sizer.aisc_database import get_shape

    sh = get_shape(name)
    return sh.weight_plf if sh else 0.0


# ---------------------------------------------------------------------------
# Build MemberSizingSummary + per-check rows
# ---------------------------------------------------------------------------


def _build_summary(
    *,
    scheme_id: str,
    beam_id: str,
    shape: WShape,
    loads: LinearBeamLoad,
    Mu_kip_ft: float,
    Vu_kip: float,
    governing_combination: LRFDResult,
    fy: float,
    e_ksi: float,
    live_denom: float,
    total_denom: float,
) -> MemberSizingSummary:
    """Materialise the four checks (flexure, shear, deflection_live,
    deflection_total) and pick the governing one."""
    span_ft = loads.span_ft
    L_in = span_ft * 12.0

    # ----- Flexure -----
    phi_Mn_kip_ft = PHI_FLEXURE * fy * shape.Zx / 12.0
    dcr_flex = _safe_div(Mu_kip_ft, phi_Mn_kip_ft)
    flex = MemberCheck(
        id=str(uuid.uuid4()),
        scheme_id=scheme_id,
        member_id=beam_id,
        member_type="beam",
        selected_size=shape.name,
        check_type="flexure",
        demand=round(Mu_kip_ft, 1),
        capacity=round(phi_Mn_kip_ft, 1),
        dcr=round(dcr_flex, 3),
        status=dcr_to_status(dcr_flex),
        load_combination=governing_combination.name,
        explanation=(
            f"Simply supported uniform load. "
            f"Mu = wu·L²/8 = {governing_combination.factored_value:.3f} klf × "
            f"({span_ft:.1f} ft)² / 8 = {Mu_kip_ft:.1f} kip-ft. "
            f"φMn = φ·Fy·Zx / 12 = {PHI_FLEXURE} × {fy:.0f} ksi × "
            f"{shape.Zx:.1f} in³ / 12 = {phi_Mn_kip_ft:.1f} kip-ft "
            f"(assumes Lb ≤ Lp; bare steel; no composite action)."
        ),
        demand_unit="kip-ft",
        capacity_unit="kip-ft",
    )

    # ----- Shear -----
    phi_Vn_kip = PHI_SHEAR * 0.6 * fy * shape.Aw
    dcr_shear = _safe_div(Vu_kip, phi_Vn_kip)
    shear = MemberCheck(
        id=str(uuid.uuid4()),
        scheme_id=scheme_id,
        member_id=beam_id,
        member_type="beam",
        selected_size=shape.name,
        check_type="shear",
        demand=round(Vu_kip, 1),
        capacity=round(phi_Vn_kip, 1),
        dcr=round(dcr_shear, 3),
        status=dcr_to_status(dcr_shear),
        load_combination=governing_combination.name,
        explanation=(
            f"Simple-span end shear. Vu = wu·L/2 = "
            f"{governing_combination.factored_value:.3f} klf × {span_ft:.1f} ft / 2 = "
            f"{Vu_kip:.1f} kip. "
            f"φVn = φv · 0.6 · Fy · Aw · Cv1 = "
            f"{PHI_SHEAR:.2f} × 0.6 × {fy:.0f} ksi × "
            f"({shape.d:.2f} in × {shape.tw:.3f} in) × 1.0 = {phi_Vn_kip:.1f} kip "
            f"(AISC 360 Eq. G2-1; Cv1 = 1.0 for h/tw ≤ 2.24√(E/Fy))."
        ),
        demand_unit="kip",
        capacity_unit="kip",
    )

    # ----- Deflection (service loads) -----
    w_live_kpi = loads.w_live_reduced_klf / 12.0  # kip/in
    w_total_kpi = loads.w_dead_klf / 12.0 + w_live_kpi
    delta_live = _deflection(w_live_kpi, L_in, e_ksi, shape.Ix)
    delta_total = _deflection(w_total_kpi, L_in, e_ksi, shape.Ix)
    delta_allow_live = L_in / live_denom
    delta_allow_total = L_in / total_denom
    dcr_dl = _safe_div(delta_live, delta_allow_live)
    dcr_dt = _safe_div(delta_total, delta_allow_total)

    defl_live = MemberCheck(
        id=str(uuid.uuid4()),
        scheme_id=scheme_id,
        member_id=beam_id,
        member_type="beam",
        selected_size=shape.name,
        check_type="deflection_live",
        demand=round(delta_live, 3),
        capacity=round(delta_allow_live, 3),
        dcr=round(dcr_dl, 3),
        status=dcr_to_status(dcr_dl),
        load_combination=f"Service L (LLR factor {loads.llr_factor:.3f})",
        explanation=(
            f"Service live-load deflection (UNFACTORED). "
            f"δL = 5·wL·L⁴ / (384·E·Ix) = "
            f"5 × {w_live_kpi:.5f} kip/in × ({L_in:.1f} in)⁴ / "
            f"(384 × {e_ksi:.0f} ksi × {shape.Ix:.0f} in⁴) = {delta_live:.3f} in. "
            f"Allowable {L_in/live_denom:.3f} in (L/{live_denom:.0f})."
        ),
        demand_unit="in",
        capacity_unit="in",
    )

    defl_total = MemberCheck(
        id=str(uuid.uuid4()),
        scheme_id=scheme_id,
        member_id=beam_id,
        member_type="beam",
        selected_size=shape.name,
        check_type="deflection_total",
        demand=round(delta_total, 3),
        capacity=round(delta_allow_total, 3),
        dcr=round(dcr_dt, 3),
        status=dcr_to_status(dcr_dt),
        load_combination="Service D + L (UNFACTORED)",
        explanation=(
            f"Service total-load deflection. δT = 5·(wD+wL)·L⁴ / (384·E·Ix) = "
            f"{delta_total:.3f} in. Allowable {L_in/total_denom:.3f} in (L/{total_denom:.0f})."
        ),
        demand_unit="in",
        capacity_unit="in",
    )

    checks = [flex, shear, defl_live, defl_total]
    governing = max(checks, key=lambda c: c.dcr)
    governing_obj = governing.model_copy(update={"governing": True})
    checks = [governing_obj if c is governing else c for c in checks]

    return MemberSizingSummary(
        member_id=beam_id,
        member_type="beam",
        selected_size=shape.name,
        weight_plf=shape.weight_plf,
        length_ft=round(span_ft, 2),
        dcr=round(governing_obj.dcr, 3),
        governing_check=governing_obj.check_type,
        status=governing_obj.status,
        all_checks=checks,
        warnings=[],
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _deflection(w_kip_per_in: float, L_in: float, e_ksi: float, Ix: float) -> float:
    """Centre deflection of a simply-supported beam under uniform load.

    Inputs in kip/in, in, ksi, in⁴ → output inches. Returns 0 for
    degenerate inputs so the caller's DCR doesn't blow up.
    """
    if L_in <= 0 or e_ksi <= 0 or Ix <= 0:
        return 0.0
    return (5.0 * w_kip_per_in * (L_in ** 4)) / (384.0 * e_ksi * Ix)


def _safe_div(numer: float, denom: float) -> float:
    if denom <= 0:
        return float("inf")
    return numer / denom


__all__ = [
    "BeamSizingInputs",
    "size_beam",
]
