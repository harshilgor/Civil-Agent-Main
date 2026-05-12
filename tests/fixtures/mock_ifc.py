"""Duck-typed in-memory IFC model for tests that don't need native IO.

The IFC extractor only relies on a tiny surface of :mod:`ifcopenshell`:

* ``model.by_type(name)``
* ``entity.is_a(name)``
* ``getattr(entity, "Elevation"/"Name"/...)``
* ``ifcopenshell.util.placement.get_local_placement`` (we monkeypatch
  this to a NumPy-free identity that reads from our entity).

These mocks satisfy that surface so every step of the IFC extractor
runs end-to-end without IfcOpenShell installed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FakeEntity:
    classes: tuple[str, ...]
    attrs: dict[str, Any] = field(default_factory=dict)

    def is_a(self, name: str) -> bool:
        return name in self.classes

    def __getattr__(self, item: str) -> Any:
        if item.startswith("_") or item == "attrs" or item == "classes":
            raise AttributeError(item)
        return self.attrs.get(item)


@dataclass
class FakeRel:
    """Mimics IfcRelContainedInSpatialStructure."""

    RelatingStructure: Any


class FakeModel:
    """Subset of IfcOpenShell file API used by the extractor."""

    def __init__(self) -> None:
        self._entities: list[FakeEntity] = []

    def add(self, entity: FakeEntity) -> FakeEntity:
        self._entities.append(entity)
        return entity

    def by_type(self, name: str) -> list[FakeEntity]:
        return [e for e in self._entities if name in e.classes]


def build_known_good_ifc(*, with_grid: bool = True, with_columns: bool = True) -> FakeModel:
    """Build the canonical 6×4 / 8-storey fixture as a duck-typed model.

    Coordinates are emitted directly in feet (no metric conversion) so
    the extractor's local-frame logic can be exercised.
    """
    model = FakeModel()

    storeys: list[FakeEntity] = []
    for i in range(8):
        st = model.add(
            FakeEntity(
                classes=("IfcBuildingStorey",),
                attrs={"Name": f"Level {i + 1}", "Elevation": float(i * 14)},
            )
        )
        storeys.append(st)

    if with_columns:
        for ix in range(6):
            for iy in range(4):
                x = ix * 30.0
                y = iy * 25.0
                for st in storeys:
                    col = FakeEntity(
                        classes=("IfcColumn",),
                        attrs={
                            "Name": f"Col {ix + 1}-{chr(ord('A') + iy)}@{st.Name}",
                            "_x": x,
                            "_y": y,
                            "ContainedInStructure": [FakeRel(RelatingStructure=st)],
                        },
                    )
                    model.add(col)

    if with_grid:
        u_axes = []
        for i in range(6):
            ax = FakeEntity(
                classes=("IfcGridAxis",),
                attrs={
                    "AxisTag": str(i + 1),
                    "AxisCurve": _axis_stub(coord=i * 30.0),
                },
            )
            u_axes.append(ax)
        v_axes = []
        for i in range(4):
            ax = FakeEntity(
                classes=("IfcGridAxis",),
                attrs={
                    "AxisTag": chr(ord("A") + i),
                    "AxisCurve": _axis_stub(coord=i * 25.0),
                },
            )
            v_axes.append(ax)
        model.add(
            FakeEntity(
                classes=("IfcGrid",),
                attrs={"UAxes": u_axes, "VAxes": v_axes, "Name": "Primary Grid"},
            )
        )

    # Elevator + Stair near building centre so cores form one mixed group.
    cx = 2.5 * 30.0  # centre between grid 3 and 4
    cy = 1.5 * 25.0  # centre between grid B and C
    elev = FakeEntity(
        classes=("IfcTransportElement",),
        attrs={"Name": "Elevator-1", "PredefinedType": "ELEVATOR", "_x": cx, "_y": cy},
    )
    stair = FakeEntity(
        classes=("IfcStairFlight",),
        attrs={"Name": "Stair-1", "_x": cx + 12.0, "_y": cy},
    )
    model.add(elev)
    model.add(stair)

    lobby = FakeEntity(
        classes=("IfcSpace",),
        attrs={"Name": "Lobby", "LongName": "Main Lobby", "_x": cx, "_y": cy + 25.0},
    )
    model.add(lobby)

    return model


def _axis_stub(*, coord: float) -> Any:
    pt = FakeEntity(classes=("IfcCartesianPoint",), attrs={"Coordinates": (coord, 0.0)})
    return FakeEntity(classes=("IfcPolyline",), attrs={"Points": [pt]})


def build_ifc_no_grid() -> FakeModel:
    """Same as good fixture but without IfcGrid — forces inference."""
    return build_known_good_ifc(with_grid=False)


def build_ifc_no_columns() -> FakeModel:
    """Architectural-only IFC — no IfcColumn entities."""
    return build_known_good_ifc(with_grid=False, with_columns=False)


def build_offgrid_ifc() -> FakeModel:
    """Grid present, but two columns are nudged off-grid to exercise
    the reconciliation path."""
    model = build_known_good_ifc()
    drift_x, drift_y = 5.0, 4.0
    for e in model.by_type("IfcColumn"):
        if e.attrs.get("_x") == 0 and e.attrs.get("_y") == 0:
            e.attrs["_x"] = drift_x
            e.attrs["_y"] = drift_y
    return model
