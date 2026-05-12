"""Column load takedown + axial sizing per AISC 360-22 Chapter E.

For each column:

1. Compute the tributary area at every level the column passes
   through.
2. Walk top-to-bottom (roof to base), accumulating dead and live
   load. Apply ASCE 7 LLR at each level using the cumulative
   influence area.
3. Run LRFD combinations at each level; record the governing
   factored load.
4. Size the column for the maximum factored load (at the base) plus
   the unbraced length given by the tallest individual floor (KL =
   K × max_floor_height).

Assumptions:

* Single size for the full column height (no stepped sizes). This is
  conservative — future versions can step sizes at every 2-3 floors.
* K = 1.0 (pinned-pinned) — gravity-only preliminary design.
* Beam reactions are not used for column loading. The column carries
  the tributary slab area directly. This is consistent with the
  "every member is auditable" principle: no hidden re-distribution.
* Weak-axis radius of gyration (r_y) — conservative for unbraced
  frames.

The LLR floor counter is cumulative-from-roof, mapped to:

* 1 floor (only the roof above): min factor 0.50
* ≥ 2 floors: min factor 0.40

This matches ASCE 7-22 §4.7.2 and is the most common LLR mistake
in preliminary tools.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Optional

from packages.engine.member_sizer.aisc_database import (
    WShape,
    column_capacity,
    find_lightest_column,
    get_shape,
)
from packages.engine.member_sizer.combinations import factored_axial_load
from packages.engine.member_sizer.constants import (
    DEFAULT_E_KSI,
    DEFAULT_FY_KSI,
    DEFAULT_K_FACTOR,
    SLENDERNESS_WARN_THRESHOLD,
    dcr_to_status,
)
from packages.engine.member_sizer.loads import compute_floor_llr_factor
from packages.engine.member_sizer.models import (
    ColumnTakedownEntry,
    MemberCheck,
    MemberSizingSummary,
)


@dataclass
class LevelTributary:
    """Per-level tributary input for the column takedown.

    ``floor_index_from_top`` is 0 for the roof, 1 for the floor below
    the roof, etc. This is what the LLR formula uses to decide the
    minimum reduction factor (0.50 vs 0.40).
    """

    level_id: str
    level_name: str
    floor_index_from_top: int
    tributary_area_sf: float
    K_LL: float
    height_ft: float
    is_roof: bool


@dataclass(frozen=True)
class ColumnSizingInputs:
    scheme_id: str
    column_id: str
    levels: tuple[LevelTributary, ...]   # ordered top → bottom
    dead_load_psf: float
    live_load_psf: float
    roof_dead_load_psf: float
    roof_live_load_psf: float
    fy_ksi: float = DEFAULT_FY_KSI
    e_ksi: float = DEFAULT_E_KSI
    k_factor: float = DEFAULT_K_FACTOR


@dataclass
class ColumnSizingResult:
    summary: MemberSizingSummary
    takedowns: list[ColumnTakedownEntry]


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


def size_column(inputs: ColumnSizingInputs) -> ColumnSizingResult:
    """Return the sizing summary and the per-level takedown trace."""
    if not inputs.levels:
        return _degenerate_result(inputs)

    takedowns = _build_takedown(inputs)

    # Governing factored axial demand = max across all levels.
    Pu_max = max(t.factored_load_kip for t in takedowns)

    # Unbraced length: longest floor-to-floor height in the column run.
    # (Conservative — pinned-pinned within a single floor; the actual
    # frame buckling length is at most one floor for a braced building.)
    max_height_ft = max(lvl.height_ft for lvl in inputs.levels if lvl.height_ft > 0)
    KL_ft = inputs.k_factor * max(max_height_ft, 1.0)

    selected = find_lightest_column(
        Pu_max,
        KL_ft,
        fy_ksi=inputs.fy_ksi,
        e_ksi=inputs.e_ksi,
    )
    if selected is None:
        selected = get_shape("W14x82") or get_shape("W10x33")
    if selected is None:
        return _degenerate_result(inputs)

    phi_Pn, slenderness = column_capacity(
        selected, KL_ft, fy_ksi=inputs.fy_ksi, e_ksi=inputs.e_ksi
    )

    governing_combo_name = _governing_combo_at_max(takedowns)
    dcr_axial = Pu_max / phi_Pn if phi_Pn > 0 else float("inf")

    axial_check = MemberCheck(
        id=str(uuid.uuid4()),
        scheme_id=inputs.scheme_id,
        member_id=inputs.column_id,
        member_type="column",
        selected_size=selected.name,
        check_type="axial_compression",
        demand=round(Pu_max, 1),
        capacity=round(phi_Pn, 1),
        dcr=round(dcr_axial, 3),
        status=dcr_to_status(dcr_axial),
        governing=True,
        load_combination=governing_combo_name,
        explanation=(
            f"AISC 360 Chapter E flexural buckling. KL = K·h = "
            f"{inputs.k_factor:.2f} × {max_height_ft:.1f} ft = {KL_ft:.1f} ft. "
            f"r_y = {selected.ry:.2f} in → KL/r = {slenderness:.1f}. "
            f"Fcr derived from Eq. E3-2/E3-3; φPn = 0.90·Fcr·Ag = {phi_Pn:.1f} kip. "
            f"Pu = {Pu_max:.1f} kip from {governing_combo_name} at base."
        ),
        demand_unit="kip",
        capacity_unit="kip",
    )

    checks: list[MemberCheck] = [axial_check]
    warnings: list[str] = []

    # Slenderness check — informational, not a failure.
    if slenderness > SLENDERNESS_WARN_THRESHOLD:
        slender_check = MemberCheck(
            id=str(uuid.uuid4()),
            scheme_id=inputs.scheme_id,
            member_id=inputs.column_id,
            member_type="column",
            selected_size=selected.name,
            check_type="slenderness",
            demand=round(slenderness, 1),
            capacity=round(SLENDERNESS_WARN_THRESHOLD, 1),
            dcr=round(slenderness / SLENDERNESS_WARN_THRESHOLD, 3),
            status="fail" if slenderness / SLENDERNESS_WARN_THRESHOLD > 1.0
                    else "near-capacity",
            load_combination="N/A",
            explanation=(
                f"KL/r = {slenderness:.1f} exceeds the AISC recommended "
                f"limit of 200. Consider intermediate bracing or a heavier "
                f"section."
            ),
            demand_unit="ratio",
            capacity_unit="ratio",
        )
        checks.append(slender_check)
        warnings.append(
            f"Column {inputs.column_id} slenderness KL/r = {slenderness:.0f} > 200."
        )

    column_height_ft = sum(lvl.height_ft for lvl in inputs.levels)

    summary = MemberSizingSummary(
        member_id=inputs.column_id,
        member_type="column",
        selected_size=selected.name,
        weight_plf=selected.weight_plf,
        length_ft=round(column_height_ft, 2),
        dcr=round(dcr_axial, 3),
        governing_check="axial_compression",
        status=axial_check.status,
        all_checks=checks,
        warnings=warnings,
    )

    return ColumnSizingResult(summary=summary, takedowns=takedowns)


# ---------------------------------------------------------------------------
# Takedown
# ---------------------------------------------------------------------------


def _build_takedown(inputs: ColumnSizingInputs) -> list[ColumnTakedownEntry]:
    """Walk levels top→bottom, accumulating loads.

    At each level we apply LLR using the *cumulative* influence area
    (sum of K_LL × A_T from the topmost level down to this one). This
    mirrors how the engineer hand-computes a takedown, and it is the
    only way the multi-floor minimum factor (0.40) becomes correct.
    """
    out: list[ColumnTakedownEntry] = []
    cum_dead_kip = 0.0
    cum_live_unreduced_kip = 0.0
    cum_influence_area = 0.0
    cum_tributary_area = 0.0

    for lvl in inputs.levels:
        if lvl.is_roof:
            dl_psf = inputs.roof_dead_load_psf
            ll_psf = inputs.roof_live_load_psf
        else:
            dl_psf = inputs.dead_load_psf
            ll_psf = inputs.live_load_psf

        # New load from this level's slab.
        new_dead_kip = (dl_psf * lvl.tributary_area_sf) / 1000.0
        new_live_kip = (ll_psf * lvl.tributary_area_sf) / 1000.0

        cum_dead_kip += new_dead_kip
        cum_live_unreduced_kip += new_live_kip
        cum_influence_area += lvl.K_LL * lvl.tributary_area_sf
        cum_tributary_area += lvl.tributary_area_sf

        floors_supported = lvl.floor_index_from_top + 1  # 1-indexed: roof = 1 floor
        # The roof itself uses the floor-LLR formula in this MVP. Roof
        # live-load reduction (R1) is applied at the BEAM level above;
        # at the column takedown we treat the roof contribution as a
        # already-mixed live load. This is conservative and matches
        # how preliminary tools size columns.
        llr = compute_floor_llr_factor(
            ll_psf if not lvl.is_roof else inputs.live_load_psf,
            cum_influence_area,
            floors_supported=floors_supported,
        )
        live_reduced_kip = cum_live_unreduced_kip * llr

        # LRFD combinations on the running totals.
        combos = factored_axial_load(cum_dead_kip, live_reduced_kip)
        gov = combos[0]

        out.append(
            ColumnTakedownEntry(
                column_id=inputs.column_id,
                level_id=lvl.level_id,
                level_name=lvl.level_name,
                level_index_from_top=lvl.floor_index_from_top,
                tributary_area_sf=round(lvl.tributary_area_sf, 1),
                cumulative_tributary_area_sf=round(cum_tributary_area, 1),
                dead_load_kip=round(cum_dead_kip, 2),
                live_load_kip=round(live_reduced_kip, 2),
                live_load_unreduced_kip=round(cum_live_unreduced_kip, 2),
                reduction_factor=round(llr, 3),
                factored_load_kip=round(gov.factored_value, 2),
                governing_combination=gov.name,
            )
        )

    return out


def _governing_combo_at_max(takedowns: list[ColumnTakedownEntry]) -> str:
    if not takedowns:
        return "1.2D + 1.6L"
    governing = max(takedowns, key=lambda t: t.factored_load_kip)
    return governing.governing_combination


def _degenerate_result(inputs: ColumnSizingInputs) -> ColumnSizingResult:
    """Used when the column has no levels (shouldn't happen but keeps
    the engine total-failure-safe)."""
    fallback = get_shape("W14x82") or get_shape("W10x33")
    name = fallback.name if fallback else "W14x82"
    plf = fallback.weight_plf if fallback else 82.0
    summary = MemberSizingSummary(
        member_id=inputs.column_id,
        member_type="column",
        selected_size=name,
        weight_plf=plf,
        length_ft=0.0,
        dcr=0.0,
        governing_check="axial_compression",
        status="unsized",
        all_checks=[],
        warnings=["Column has no level information; sizing skipped."],
    )
    return ColumnSizingResult(summary=summary, takedowns=[])


__all__ = [
    "LevelTributary",
    "ColumnSizingInputs",
    "ColumnSizingResult",
    "size_column",
]
