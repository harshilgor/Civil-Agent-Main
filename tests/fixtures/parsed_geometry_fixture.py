"""Reusable ParsedGeometry test fixture for the column-layout generator.

Shape mirrors the JS frontend fixture
(``js/data/fixtures/parsed-geometry.fixture.js``) so tests share
the same building across both stacks. Coordinates in feet.

The building:
  * 8 levels (ground 18 ft, typical 13 ft).
  * Floor plate ~140 ft × 78 ft (matches the JS fixture).
  * 10 grid lines (1–6 horizontal, A–D vertical).
  * 2 cores (mixed + service).
  * 1 opening (stair well at L6).
  * 6 existing perimeter columns along grid line A.
  * 2 no-column zones (lobby on L1, atrium on L2–L5).
"""

from __future__ import annotations


def _square(x0: float, y0: float, x1: float, y1: float) -> list[dict]:
    return [
        {"x": x0, "y": y0},
        {"x": x1, "y": y0},
        {"x": x1, "y": y1},
        {"x": x0, "y": y1},
    ]


_FOOTPRINT = _square(0, 0, 140, 78)

_LEVEL_SPECS = [
    ("L1", "Level 1", 0.0, 18.0, 1.00, "ifc"),
    ("L2", "Level 2", 18.0, 13.0, 1.00, "ifc"),
    ("L3", "Level 3", 31.0, 13.0, 0.98, "ifc"),
    ("L4", "Level 4", 44.0, 13.0, 0.98, "ifc"),
    ("L5", "Level 5", 57.0, 13.0, 0.96, "ifc"),
    ("L6", "Level 6", 70.0, 13.0, 0.96, "ifc"),
    ("L7", "Level 7", 83.0, 13.0, 0.94, "ifc"),
    ("L8", "Roof",    96.0, 0.0,  0.92, "inferred"),
]


def make_fixture() -> dict:
    """Return a fresh copy of the canonical 8-story fixture."""
    return {
        "levels": [
            {
                "id": lid,
                "name": name,
                "elevation": elev,
                "height": height,
                "confidence": conf,
                "source": source,
                "planBoundary": [dict(p) for p in _FOOTPRINT],
            }
            for (lid, name, elev, height, conf, source) in _LEVEL_SPECS
        ],
        "gridLines": [
            {"id": "G1", "axis": "x", "label": "1", "coordinate": 0.0,   "confidence": 1.00, "source": "ifc"},
            {"id": "G2", "axis": "x", "label": "2", "coordinate": 28.0,  "confidence": 0.98, "source": "ifc"},
            {"id": "G3", "axis": "x", "label": "3", "coordinate": 56.0,  "confidence": 0.96, "source": "ifc"},
            {"id": "G4", "axis": "x", "label": "4", "coordinate": 84.0,  "confidence": 0.92, "source": "ifc"},
            {"id": "G5", "axis": "x", "label": "5", "coordinate": 112.0, "confidence": 0.84, "source": "inferred"},
            {"id": "G6", "axis": "x", "label": "6", "coordinate": 140.0, "confidence": 0.96, "source": "ifc"},
            {"id": "GA", "axis": "y", "label": "A", "coordinate": 0.0,   "confidence": 1.00, "source": "ifc"},
            {"id": "GB", "axis": "y", "label": "B", "coordinate": 26.0,  "confidence": 0.96, "source": "ifc"},
            {"id": "GC", "axis": "y", "label": "C", "coordinate": 52.0,  "confidence": 0.93, "source": "ifc"},
            {"id": "GD", "axis": "y", "label": "D", "coordinate": 78.0,  "confidence": 0.89, "source": "inferred"},
        ],
        "cores": [
            {
                "id": "CORE-1",
                "type": "mixed",
                "confidence": 0.95,
                "source": "ifc",
                "levelIds": ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"],
                "boundary": _square(38, 22, 56, 50),
            },
            {
                "id": "CORE-2",
                "type": "service",
                "confidence": 0.88,
                "source": "ifc",
                "levelIds": ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"],
                "boundary": _square(104, 18, 120, 44),
            },
        ],
        "openings": [
            {
                "id": "OPEN-1",
                "type": "stair_well",
                "levelId": "L6",
                "confidence": 0.9,
                "source": "ifc",
                "boundary": _square(40, 22, 54, 36),
            },
        ],
        "existingColumns": [
            {"id": "C1", "x": 0.0,   "y": 0.0, "startLevel": "L1", "endLevel": "L8",
             "size": "W14x82", "gridLabel": "A-1", "gridAligned": True, "confidence": 1.00, "source": "ifc"},
            {"id": "C2", "x": 28.0,  "y": 0.0, "startLevel": "L1", "endLevel": "L8",
             "size": "W14x90", "gridLabel": "A-2", "gridAligned": True, "confidence": 1.00, "source": "ifc"},
            {"id": "C3", "x": 56.0,  "y": 0.0, "startLevel": "L1", "endLevel": "L8",
             "size": "W14x90", "gridLabel": "A-3", "gridAligned": True, "confidence": 1.00, "source": "ifc"},
            {"id": "C4", "x": 84.0,  "y": 0.0, "startLevel": "L1", "endLevel": "L8",
             "size": "W14x90", "gridLabel": "A-4", "gridAligned": True, "confidence": 1.00, "source": "ifc"},
            {"id": "C5", "x": 112.0, "y": 0.0, "startLevel": "L1", "endLevel": "L8",
             "size": "W14x90", "gridLabel": "A-5", "gridAligned": True, "confidence": 0.95, "source": "ifc"},
            {"id": "C6", "x": 140.0, "y": 0.0, "startLevel": "L1", "endLevel": "L8",
             "size": "W14x82", "gridLabel": "A-6", "gridAligned": True, "confidence": 1.00, "source": "ifc"},
        ],
        "noColumnZones": [
            {
                "id": "NCZ-1",
                "name": "L1 Lobby",
                "reason": "Architectural clear-span lobby",
                "source": "inferred",
                "confidence": 0.8,
                "levelIds": ["L1"],
                "boundary": _square(4, 50, 30, 72),
            },
            {
                "id": "NCZ-2",
                "name": "Atrium",
                "reason": "Long-span atrium void",
                "source": "ifc",
                "confidence": 0.92,
                "levelIds": ["L2", "L3", "L4", "L5"],
                "boundary": _square(88, 56, 118, 74),
            },
        ],
        "floorPlates": [],
        "buildingBounds": {"minX": 0.0, "minY": 0.0, "maxX": 140.0, "maxY": 78.0},
        "metadata": {
            "schemaVersion": "parsed_geometry@1.0.0",
            "parserVersion": "1.0.0",
            "runId": "fixture-8th-street-001",
            "fileFormat": "ifc",
            "fileHash": "sha256:fixture",
            "overallConfidence": 0.92,
            "status": "completed",
            "completedSteps": [
                "download", "init", "levels", "grids", "cores", "openings",
                "floor_plates", "existing_elements", "no_column_zones",
                "validation", "complete",
            ],
            "warnings": [],
            "originTransform": {"tx": 0.0, "ty": 0.0, "units": "ft", "rotation_rad": 0.0},
            "parsedAt": "2026-04-30T20:00:00+00:00",
            "durationMs": 4200,
        },
    }


__all__ = ["make_fixture"]
