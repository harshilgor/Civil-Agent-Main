"""CivilAgent Load Calculator + Member Sizer (Agent 4).

Public surface intentionally exposes only:

* :func:`calculate_scheme_sizing` — deterministic gravity-only
  member sizing pipeline. Reads Agent 1 geometry + Agent 3 schemes,
  produces per-member checks, takedowns, and updated metrics.
* The output Pydantic models — the contract every downstream
  consumer (worker, API, frontend) reads.
* :data:`SIZER_VERSION` — bump when the calculator's deterministic
  output changes for a given input.

Anything else is an implementation detail. Do not reach into
``aisc_database``/``loads``/``combinations``/``beam_sizer``/``column_sizer``/
``tributary``/``metrics`` from outside this package.
"""

from packages.engine.member_sizer.calculator import calculate_scheme_sizing
from packages.engine.member_sizer.constants import (
    SIZER_VERSION,
    DCR_THRESHOLDS,
    dcr_to_status,
)
from packages.engine.member_sizer.models import (
    ColumnTakedownEntry,
    MemberCheck,
    MemberSizingSummary,
    SizingAssumptions,
    SizingResult,
    UpdatedSchemeMetrics,
)


__all__ = [
    "ColumnTakedownEntry",
    "DCR_THRESHOLDS",
    "MemberCheck",
    "MemberSizingSummary",
    "SizingAssumptions",
    "SizingResult",
    "SIZER_VERSION",
    "UpdatedSchemeMetrics",
    "calculate_scheme_sizing",
    "dcr_to_status",
]
