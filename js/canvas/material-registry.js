/**
 * Material registry — single source of truth for every Three.js material
 * used by the structural viewer.
 *
 * Materials are *factory functions*: every call returns a freshly cloned
 * material instance. The page-mode controller, hover/selection layer,
 * and D/C overlay all mutate `material.opacity` and `material.color`
 * directly, so sharing a single instance across meshes would leak
 * mutations across the scene. **Do not** export a singleton material.
 *
 * Visual rules:
 *   * MeshLambertMaterial / MeshBasicMaterial only — no PBR, no env maps.
 *   * Edge outlines via LineBasicMaterial / LineDashedMaterial.
 *   * No shadow casting/receiving (engineering review surface, not a
 *     game). Shadow maps are disabled at the renderer level.
 */

import * as THREE from "three";
import { dcrToColor as sharedDcrToColor } from "../data/constants.js";

// Re-export so overlay code can pull the canonical mapping from the
// material registry (one import for "all visual config").
export { dcrToColor } from "../data/constants.js";

// ---------------------------------------------------------------------------
// Color palette
// ---------------------------------------------------------------------------

export const PALETTE = Object.freeze({
  // Surfaces
  floorPlate:   0x334155,
  floorEdge:    0x64748b,
  core:         0x1e293b,
  coreEdge:     0x475569,
  ground:       0x0f172a,

  // Members
  column:       0x94a3b8,
  beam:         0x94a3b8,
  shearWall:    0x64748b,
  shearWallEdge:0x4b5563,

  // Constraint visuals
  noColumnZone: 0xef4444,
  opening:      0x9ca3af,

  // Overlays
  loadArrow:    0x6c8db5,
  tributary:    0x3b82f6,
  selection:    0x3b82f6,
  warning:      0xf59e0b,

  // Grids
  gridLine:     0x334155,
});

// ---------------------------------------------------------------------------
// Base materials — call these to get a fresh per-mesh clone.
// ---------------------------------------------------------------------------

export const BASE_MATERIALS = Object.freeze({
  floorPlate: () => new THREE.MeshLambertMaterial({
    color: PALETTE.floorPlate,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),

  floorPlateEdge: () => new THREE.LineBasicMaterial({
    color: PALETTE.floorEdge,
    transparent: true,
    opacity: 0.6,
  }),

  core: () => new THREE.MeshLambertMaterial({
    color: PALETTE.core,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),

  coreEdge: () => new THREE.LineBasicMaterial({
    color: PALETTE.coreEdge,
    transparent: true,
    opacity: 0.55,
  }),

  column: () => new THREE.MeshLambertMaterial({
    color: PALETTE.column,
    transparent: true,
    opacity: 0.8,
  }),

  beam: () => new THREE.MeshLambertMaterial({
    color: PALETTE.beam,
    transparent: true,
    opacity: 0.75,
  }),

  shearWall: () => new THREE.MeshLambertMaterial({
    color: PALETTE.shearWall,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
  }),

  shearWallEdge: () => new THREE.LineBasicMaterial({
    color: PALETTE.shearWallEdge,
    transparent: true,
    opacity: 0.55,
  }),

  noColumnZoneFill: () => new THREE.MeshBasicMaterial({
    color: PALETTE.noColumnZone,
    transparent: true,
    opacity: 0.10,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),

  noColumnZoneOutline: () => new THREE.LineDashedMaterial({
    color: PALETTE.noColumnZone,
    transparent: true,
    opacity: 0.55,
    dashSize: 1.6,
    gapSize: 0.9,
  }),

  openingOutline: () => new THREE.LineBasicMaterial({
    color: PALETTE.opening,
    transparent: true,
    opacity: 0.6,
  }),

  openingFill: () => new THREE.MeshBasicMaterial({
    color: PALETTE.opening,
    transparent: true,
    opacity: 0.10,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),

  gridLine: () => new THREE.LineBasicMaterial({
    color: PALETTE.gridLine,
    transparent: true,
    opacity: 0.55,
  }),

  groundPlane: () => new THREE.MeshBasicMaterial({
    color: PALETTE.ground,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  }),

  loadArrow: () => new THREE.MeshBasicMaterial({
    color: PALETTE.loadArrow,
    transparent: true,
    opacity: 0.55,
  }),

  tributaryArea: () => new THREE.MeshBasicMaterial({
    color: PALETTE.tributary,
    transparent: true,
    opacity: 0.10,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),

  selectionOutline: () => new THREE.LineBasicMaterial({
    color: PALETTE.selection,
    transparent: true,
    opacity: 0.95,
  }),

  selectionFill: () => new THREE.MeshBasicMaterial({
    color: PALETTE.selection,
    transparent: true,
    opacity: 0.18,
    side: THREE.BackSide,
    depthWrite: false,
  }),
});

// Re-export the dcrToColor name with the spelling overlay code expects
// without forcing a path change.
export { sharedDcrToColor as colorForDcr };
