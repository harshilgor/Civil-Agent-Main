/**
 * Member geometry — coordinates are in plan units (feet) and align with
 * the gridLines coordinates from mock-project.js.
 *
 * Status: 'pass' | 'warn' | 'fail' | 'unsized'
 */

export const columns = [
  { id: "C1",  gridLabel: "A-1", x: 0,   y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "620 sf", axialLoad: "510 kip", dcr: 0.68, status: "pass",    locked: true,  source: "engineer" },
  { id: "C2",  gridLabel: "A-2", x: 28,  y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "660 sf", axialLoad: "545 kip", dcr: 0.72, status: "pass",    locked: false, source: "generated" },
  { id: "C3",  gridLabel: "A-3", x: 56,  y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "640 sf", axialLoad: "528 kip", dcr: 0.70, status: "pass",    locked: false, source: "generated" },
  { id: "C4",  gridLabel: "A-4", x: 84,  y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "740 sf", axialLoad: "640 kip", dcr: 0.74, status: "pass",    locked: false, source: "generated" },
  { id: "C5",  gridLabel: "A-5", x: 112, y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "680 sf", axialLoad: "598 kip", dcr: 0.81, status: "pass",    locked: false, source: "imported" },
  { id: "C6",  gridLabel: "A-6", x: 140, y: 0,  startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "560 sf", axialLoad: "470 kip", dcr: 0.66, status: "pass",    locked: true,  source: "engineer" },

  { id: "C7",  gridLabel: "B-1", x: 0,   y: 26, startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "620 sf", axialLoad: "510 kip", dcr: 0.68, status: "pass",    locked: false, source: "generated" },
  { id: "C8",  gridLabel: "B-2", x: 28,  y: 26, startLevel: "L1", endLevel: "L8", size: "W14x99", tributaryArea: "830 sf", axialLoad: "720 kip", dcr: 0.88, status: "warn",    locked: false, source: "generated" },
  { id: "C9",  gridLabel: "B-5", x: 112, y: 26, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "680 sf", axialLoad: "598 kip", dcr: 0.81, status: "pass",    locked: false, source: "generated" },
  { id: "C10", gridLabel: "B-6", x: 140, y: 26, startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "620 sf", axialLoad: "510 kip", dcr: 0.68, status: "pass",    locked: false, source: "generated" },

  { id: "C11", gridLabel: "C-1", x: 0,   y: 52, startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "640 sf", axialLoad: "535 kip", dcr: 0.71, status: "pass",    locked: false, source: "generated" },
  { id: "C12", gridLabel: "C-2", x: 28,  y: 52, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "740 sf", axialLoad: "640 kip", dcr: 0.74, status: "pass",    locked: false, source: "generated" },
  { id: "C13", gridLabel: "C-3", x: 56,  y: 52, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "740 sf", axialLoad: "640 kip", dcr: 0.74, status: "pass",    locked: false, source: "generated" },
  { id: "C14", gridLabel: "C-4", x: 84,  y: 52, startLevel: "L1", endLevel: "L8", size: "W14x99", tributaryArea: "810 sf", axialLoad: "720 kip", dcr: 0.86, status: "warn",    locked: false, source: "generated" },
  { id: "C15", gridLabel: "C-5", x: 112, y: 52, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "680 sf", axialLoad: "598 kip", dcr: 0.81, status: "pass",    locked: false, source: "imported" },
  { id: "C16", gridLabel: "C-6", x: 140, y: 52, startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "560 sf", axialLoad: "470 kip", dcr: 0.66, status: "pass",    locked: true,  source: "engineer" },

  { id: "C17", gridLabel: "D-1", x: 0,   y: 78, startLevel: "L1", endLevel: "L8", size: "W14x82", tributaryArea: "620 sf", axialLoad: "510 kip", dcr: 0.69, status: "pass",    locked: false, source: "generated" },
  { id: "C18", gridLabel: "D-2", x: 28,  y: 78, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "660 sf", axialLoad: "545 kip", dcr: 0.72, status: "pass",    locked: false, source: "generated" },
  { id: "C19", gridLabel: "D-3", x: 56,  y: 78, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "660 sf", axialLoad: "545 kip", dcr: 0.72, status: "pass",    locked: false, source: "generated" },
  { id: "C20", gridLabel: "D-4", x: 84,  y: 78, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "740 sf", axialLoad: "640 kip", dcr: 0.74, status: "pass",    locked: false, source: "generated" },
  { id: "C21", gridLabel: "D-5", x: 112, y: 78, startLevel: "L1", endLevel: "L8", size: "W14x90", tributaryArea: "680 sf", axialLoad: "598 kip", dcr: 0.81, status: "pass",    locked: false, source: "generated" },
  { id: "C22", gridLabel: "D-6", x: 140, y: 78, startLevel: "L1", endLevel: "L8", size: "W14x99", tributaryArea: "810 sf", axialLoad: "720 kip", dcr: 0.88, status: "warn",    locked: false, source: "generated" },
];

export const beams = [
  { id: "B12", start: [0, 0],   end: [140, 0],  levelId: "L6", span: "28.0 ft", size: "W18x35", tributaryWidth: "12.5 ft", uniformLoad: "1.15 klf", momentDemand: "184 kip-ft", shearDemand: "42 kip", dcr: 0.82, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B21", start: [0, 52],  end: [140, 52], levelId: "L6", span: "31.8 ft", size: "W21x44", tributaryWidth: "13.5 ft", uniformLoad: "1.32 klf", momentDemand: "318 kip-ft", shearDemand: "76 kip", dcr: 0.96, governingCheck: "Live-load deflection",  status: "warn", locked: false },
  { id: "B33", start: [0, 78],  end: [140, 78], levelId: "L6", span: "30.2 ft", size: "W18x40", tributaryWidth: "11.8 ft", uniformLoad: "1.08 klf", momentDemand: "228 kip-ft", shearDemand: "50 kip", dcr: 0.72, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B66", start: [140, 0], end: [140, 78], levelId: "L6", span: "29.5 ft", size: "W18x35", tributaryWidth: "14.0 ft", uniformLoad: "1.40 klf", momentDemand: "334 kip-ft", shearDemand: "80 kip", dcr: 1.02, governingCheck: "Vibration",              status: "fail", locked: false },
  { id: "B41", start: [0, 26],  end: [140, 26], levelId: "L6", span: "31.0 ft", size: "W18x40", tributaryWidth: "12.5 ft", uniformLoad: "1.15 klf", momentDemand: "210 kip-ft", shearDemand: "48 kip", dcr: 0.78, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B05", start: [0, 0],   end: [0, 78],   levelId: "L6", span: "26.0 ft", size: "W18x35", tributaryWidth: "10.0 ft", uniformLoad: "0.95 klf", momentDemand: "152 kip-ft", shearDemand: "38 kip", dcr: 0.64, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B07", start: [56, 0],  end: [56, 78],  levelId: "L6", span: "26.0 ft", size: "W18x35", tributaryWidth: "11.0 ft", uniformLoad: "1.05 klf", momentDemand: "168 kip-ft", shearDemand: "40 kip", dcr: 0.69, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B09", start: [84, 0],  end: [84, 78],  levelId: "L6", span: "26.0 ft", size: "W18x35", tributaryWidth: "11.0 ft", uniformLoad: "1.05 klf", momentDemand: "168 kip-ft", shearDemand: "40 kip", dcr: 0.69, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B11", start: [112, 0], end: [112, 78], levelId: "L6", span: "26.0 ft", size: "W18x40", tributaryWidth: "12.5 ft", uniformLoad: "1.20 klf", momentDemand: "194 kip-ft", shearDemand: "46 kip", dcr: 0.81, governingCheck: "Flexure",                status: "pass", locked: false },
  { id: "B14", start: [28, 0],  end: [28, 78],  levelId: "L6", span: "26.0 ft", size: "W18x35", tributaryWidth: "11.0 ft", uniformLoad: "1.05 klf", momentDemand: "168 kip-ft", shearDemand: "40 kip", dcr: 0.69, governingCheck: "Flexure",                status: "pass", locked: false },
];

export const shearWalls = [
  { id: "SW1", direction: "N-S", boundary: [38, 22, 4, 28],  length: "32 ft", thickness: 12, levels: "L1-L8", driftContribution: "34%", dcr: 0.86, status: "pass", locked: true },
  { id: "SW2", direction: "E-W", boundary: [104, 18, 16, 4], length: "44 ft", thickness: 12, levels: "L1-L8", driftContribution: "42%", dcr: 1.04, status: "fail", locked: false },
];

export const braces = [
  { id: "BR7", start: [28, 26], end: [56, 52], levels: "L1-L4", frameLine: "Grid B", dcr: 0.79, status: "pass" },
  { id: "BR9", start: [112, 26], end: [140, 52], levels: "L3-L8", frameLine: "Grid 5", dcr: 0.91, status: "warn" },
];

export const loadCases = [
  { id: "DL", name: "Dead Load",        type: "dead",      value: 70,  units: "psf", source: "Composite slab default",      approved: true  },
  { id: "LL", name: "Office Live Load", type: "live",      value: 50,  units: "psf", source: "IBC 2021 occupancy default",  approved: true  },
  { id: "EQ", name: "Equipment Load",   type: "equipment", value: 18,  units: "psf", source: "Equipment_Load_Schedule.xlsx", approved: false },
  { id: "W",  name: "Wind Base",        type: "wind",      value: 110, units: "mph", source: "ASCE 7-16",                    approved: true  },
  { id: "E",  name: "Seismic",          type: "seismic",   value: 0.43, units: "Sds", source: "Seismic_Criteria_Memo.pdf",   approved: true  },
];

export const issues = [
  { id: "I1", severity: "Warning", objectType: "beam",      objectId: "B21", title: "B21 near capacity",          description: "Live-load deflection controls on a 31.8 ft span.",  suggestedActions: ["Increase size", "Add support", "Allow deeper beam"], dcr: 0.96 },
  { id: "I2", severity: "Fail",    objectType: "shearWall", objectId: "SW2", title: "SW2 failing shear check",    description: "Shear demand exceeds capacity under E-W seismic case.", suggestedActions: ["Thicken wall", "Extend wall", "Add paired wall"], dcr: 1.04 },
  { id: "I3", severity: "Warning", objectType: "load",      objectId: "EQ",  title: "Equipment loads unapproved", description: "Rooftop equipment loads are not mapped to bays.",      suggestedActions: ["Open source document", "Map to Level 8", "Approve assumption"], dcr: 0    },
];
