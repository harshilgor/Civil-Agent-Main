export const projects = [
  {
    id: "8th-street",
    name: "8th Street Mixed-Use",
    location: "Davis, CA",
    code: "IBC 2021 / Steel",
    codeBasis: "IBC 2021 / ASCE 7-16",
    materialSystem: "Steel composite",
    status: "Draft",
    updated: "Today",
    stories: 8,
    activeSchemeId: "A",
    assumptionSet: "Set v3",
    lastRecalculatedAt: "12 min ago",
  },
  {
    id: "river-lab",
    name: "River Lab Addition",
    location: "Sacramento, CA",
    code: "CBC 2022 / Concrete",
    codeBasis: "CBC 2022 / ASCE 7-22",
    materialSystem: "Concrete flat plate",
    status: "Needs Review",
    updated: "Yesterday",
    stories: 4,
    activeSchemeId: "A",
    assumptionSet: "Set v1",
    lastRecalculatedAt: "1 day ago",
  },
  {
    id: "northline",
    name: "Northline Garage",
    location: "Reno, NV",
    code: "IBC 2024 / Hybrid",
    codeBasis: "IBC 2024 / ASCE 7-22",
    materialSystem: "Hybrid steel + concrete",
    status: "Ready",
    updated: "Apr 24",
    stories: 6,
    activeSchemeId: "B",
    assumptionSet: "Set v2",
    lastRecalculatedAt: "5 days ago",
  },
];

export const levels = [
  { id: "L1", name: "Level 1", elevation: 0, height: 18 },
  { id: "L2", name: "Level 2", elevation: 18, height: 13 },
  { id: "L3", name: "Level 3", elevation: 31, height: 13 },
  { id: "L4", name: "Level 4", elevation: 44, height: 13 },
  { id: "L5", name: "Level 5", elevation: 57, height: 13 },
  { id: "L6", name: "Level 6", elevation: 70, height: 13 },
  { id: "L7", name: "Level 7", elevation: 83, height: 13 },
  { id: "L8", name: "Roof", elevation: 96, height: 0 },
];

export const gridLines = [
  { id: "G1", axis: "x", label: "1", coordinate: 0, locked: true, confidence: "100%" },
  { id: "G2", axis: "x", label: "2", coordinate: 28, locked: true, confidence: "98%" },
  { id: "G3", axis: "x", label: "3", coordinate: 56, locked: false, confidence: "96%" },
  { id: "G4", axis: "x", label: "4", coordinate: 84, locked: false, confidence: "92%" },
  { id: "G5", axis: "x", label: "5", coordinate: 112, locked: false, confidence: "84%" },
  { id: "G6", axis: "x", label: "6", coordinate: 140, locked: true, confidence: "96%" },
  { id: "GA", axis: "y", label: "A", coordinate: 0, locked: true, confidence: "100%" },
  { id: "GB", axis: "y", label: "B", coordinate: 26, locked: true, confidence: "96%" },
  { id: "GC", axis: "y", label: "C", coordinate: 52, locked: true, confidence: "93%" },
  { id: "GD", axis: "y", label: "D", coordinate: 78, locked: false, confidence: "89%" },
];

export const cores = [
  {
    id: "CORE-1",
    type: "mixed",
    boundary: [38, 22, 18, 28],
    levels: "L1-L8",
    conflicts: "None",
  },
  {
    id: "CORE-2",
    type: "service",
    boundary: [104, 18, 16, 26],
    levels: "L1-L8",
    conflicts: "Opening review near Grid 5",
  },
];

export const noColumnZones = [
  {
    id: "NCZ-1",
    name: "L1 Lobby",
    boundary: [4, 50, 26, 22],
    reason: "Architectural clear-span lobby",
    source: "Floor_Plans_A1-A8.pdf",
  },
  {
    id: "NCZ-2",
    name: "Atrium",
    boundary: [88, 56, 30, 18],
    reason: "Long-span atrium void",
    source: "Architectural_Model_Level_Set.rvt",
  },
];

export const slabZones = [
  {
    id: "SLAB-A",
    boundary: [0, 0, 140, 78],
    system: "Composite slab",
    thickness: '3.25" LW concrete on 2" deck',
    loadPsf: "70 psf",
    status: "pass",
  },
  {
    id: "SLAB-ROOF",
    boundary: [88, 56, 30, 18],
    system: "Roof framing",
    thickness: "Metal deck",
    loadPsf: "95 psf equipment",
    status: "warn",
  },
];

export const buildingBounds = { minX: -8, maxX: 148, minY: -8, maxY: 86 };

export const projectMeta = {
  name: "8th Street Mixed-Use",
  location: "Davis, CA",
  codeBasis: "IBC 2021 / ASCE 7-16",
  materialSystem: "Steel composite",
  status: "Draft",
  lastRecalculatedAt: "12 min ago",
};
