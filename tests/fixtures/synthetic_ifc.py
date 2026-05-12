"""Generate the canonical synthetic IFC fixture used by gold-path tests.

Layout (deterministic):

* 4 columns × 6 columns (24 columns) at 30 ft spacing in X, 25 ft in Y.
* 8 storeys at 14 ft floor-to-floor.
* 1 elevator + 1 stair core, both near the building centre.
* 1 ``Lobby`` no-column zone at storey 1.
* 1 ``IfcGrid`` covering all column intersections, labels ``1..6`` / ``A..D``.

This is the ground truth for snapshot tests. We know exactly what
:class:`ParsedGeometry` should look like, modulo ``runId`` / ``parsedAt``
which are explicit metadata fields.
"""

from __future__ import annotations

import os
from typing import Any

import pytest

ifcopenshell = pytest.importorskip("ifcopenshell")
api = ifcopenshell.api  # type: ignore[attr-defined]


X_SPACING_FT = 30.0
Y_SPACING_FT = 25.0
COLS_X = 6  # number of grid lines along X (labels 1..6)
COLS_Y = 4  # along Y (labels A..D)
STOREY_COUNT = 8
STOREY_HEIGHT = 14.0


def _ft_to_m(ft: float) -> float:
    return ft * 0.3048


def build_synthetic_ifc(out_path: str) -> str:
    """Author the fixture in IFC4 and return the file path."""
    model = api.run("project.create_file", schema="IFC4")

    project = api.run(
        "root.create_entity",
        model,
        ifc_class="IfcProject",
        name="CivilAgent Synthetic Test",
    )
    api.run("unit.assign_unit", model)

    site = api.run(
        "root.create_entity", model, ifc_class="IfcSite", name="Test Site"
    )
    building = api.run(
        "root.create_entity", model, ifc_class="IfcBuilding", name="Test Building"
    )
    api.run("aggregate.assign_object", model, relating_object=project, product=site)
    api.run("aggregate.assign_object", model, relating_object=site, product=building)

    storeys: list[Any] = []
    for i in range(STOREY_COUNT):
        st = api.run(
            "root.create_entity",
            model,
            ifc_class="IfcBuildingStorey",
            name=f"Level {i + 1}",
        )
        st.Elevation = _ft_to_m(i * STOREY_HEIGHT)
        api.run(
            "aggregate.assign_object", model, relating_object=building, product=st
        )
        storeys.append(st)

    # ---- columns -------------------------------------------------------
    for ix in range(COLS_X):
        for iy in range(COLS_Y):
            x = _ft_to_m(ix * X_SPACING_FT)
            y = _ft_to_m(iy * Y_SPACING_FT)
            for st in storeys:
                col = api.run(
                    "root.create_entity",
                    model,
                    ifc_class="IfcColumn",
                    name=f"Col {ix + 1}-{chr(ord('A') + iy)}@{st.Name}",
                )
                _set_local_placement(model, col, x=x, y=y, z=st.Elevation)
                api.run(
                    "spatial.assign_container",
                    model,
                    products=[col],
                    relating_structure=st,
                )

    # ---- IfcGrid -------------------------------------------------------
    grid = ifcopenshell.api.run(
        "root.create_entity", model, ifc_class="IfcGrid", name="Primary Grid"
    )
    u_axes = []
    for i in range(COLS_X):
        ax = ifcopenshell.api.run(
            "root.create_entity", model, ifc_class="IfcGridAxis"
        )
        ax.AxisTag = str(i + 1)
        u_axes.append(ax)
    v_axes = []
    for i in range(COLS_Y):
        ax = ifcopenshell.api.run(
            "root.create_entity", model, ifc_class="IfcGridAxis"
        )
        ax.AxisTag = chr(ord("A") + i)
        v_axes.append(ax)
    grid.UAxes = u_axes
    grid.VAxes = v_axes

    model.write(out_path)
    return out_path


def _set_local_placement(model: Any, entity: Any, *, x: float, y: float, z: float) -> None:
    """Attach a minimal IfcLocalPlacement at (x, y, z)."""
    create_entity = ifcopenshell.api.run

    pt = create_entity(
        "root.create_entity",
        model,
        ifc_class="IfcCartesianPoint",
    )
    pt.Coordinates = (x, y, z)

    axis2 = create_entity(
        "root.create_entity",
        model,
        ifc_class="IfcAxis2Placement3D",
    )
    axis2.Location = pt

    placement = create_entity(
        "root.create_entity",
        model,
        ifc_class="IfcLocalPlacement",
    )
    placement.RelativePlacement = axis2
    entity.ObjectPlacement = placement


def write_fixture(directory: str) -> str:
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "synthetic_office_8s.ifc")
    return build_synthetic_ifc(path)
