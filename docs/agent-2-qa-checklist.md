# Agent 2 — 3D Geometry Builder · Manual QA Checklist

This is the verification checklist for the 3D viewer refactor delivered
by Agent 2. Run through it whenever you change anything in
`js/canvas/` or `js/data/fixtures/`.

The repo has no JS test runner configured, so this document is the
source of truth for "is the viewer working?". Each item maps directly
to an acceptance criterion in the Agent 2 system prompt.

> Smoke command: serve the project (e.g. `python -m http.server 5500`),
> open the workspace, and walk through the steps below.

## Geometry rendering

- [ ] Geometry page: floor plates are visible with crisp edge outlines on every level.
- [ ] Geometry page: grid lines are visible across the building footprint and their labels are readable at default zoom **and** when zoomed all the way out.
- [ ] Geometry page: cores render as translucent volumes (≤ 0.5 opacity) with edge outlines at the top and bottom of their span.
- [ ] Geometry page: a subtle ground plane and grid helper are visible *under* the building.
- [ ] Geometry page: openings (if present in fixture) render as outlined translucent zones on their level.
- [ ] No-column zones: ≤ 0.10 fill opacity, dashed outline, never visually dominates the slab.
- [ ] Existing columns from `ParsedGeometry` are visible as light-grey prisms spanning their start/end levels.

## Page modes

- [ ] **Geometry**: structural members fade out, slabs/grids/cores/NCZ dominate.
- [ ] **Placement**: columns and shear walls are bright; slabs ≤ 0.5 opacity; no-column zones visible.
- [ ] **Loads**: load arrows + tributary polygons appear; structural members visible but not overpowering.
- [ ] **Schemes**: members are bright and beams are visible.
- [ ] **Sizing**: members render in D/C colors (green/yellow/orange/red); slabs and grids fade back.
- [ ] Page transitions animate smoothly (~200 ms). No flicker, no duplicate objects, no opacity leaks.
- [ ] Rapid page switching (Loads → Sizing → Loads in quick succession) lands at the correct final profile every time.
- [ ] Layer popover toggles (Floor plates, Grids, Cores, etc.) hide/show their layer regardless of the active page profile.

## Sizing & load overlays

- [ ] Sizing page: column/beam/wall colors map to DCR via the shared bands:
      `< 0.85` green, `0.85–0.95` yellow, `0.95–1.00` orange, `> 1.00` red.
- [ ] Leaving the Sizing page restores every member to its original color.
- [ ] Loads page: arrows are *muted* slate-blue (not the legacy bright yellow), opacity ~0.55.
- [ ] Loads page: tributary polygons render at ~0.10 fill opacity, on the active framing level.

## Selection & interaction

- [ ] Hovering a structural element changes the cursor to `pointer` and gives the mesh a subtle opacity bump.
- [ ] Clicking a column/beam/wall:
    - draws a blue wireframe outline around it,
    - dims every other element (smooth ~200 ms animation, not a snap),
    - updates `state.selectedObject = { type, id }` (visible in the Inspector panel).
- [ ] Clicking empty space clears the outline, animates opacities back to the page-mode baseline, and sets `state.selectedObject = null`.
- [ ] Double-clicking an element animates the camera to frame it.
- [ ] Double-clicking empty space animates the camera to the full-model fit preset.
- [ ] Selecting an element from the inspector / table view (i.e. setting `state.selectedObject` from outside the viewer) draws the same outline + dim treatment.
- [ ] A `civilagent:element-selected` DOM event fires on the canvas container with `{ type, id, data }` on click.
- [ ] A `civilagent:element-deselected` DOM event fires when clicking empty space.

### Selection × page-mode interactions

- [ ] Select a column on **Placement** (high column opacity), then switch to **Geometry** (column profile factor ≈ 0.20). Expected: selection clears automatically because the target opacity for the column would drop below the visibility threshold; the wireframe disappears with the page transition rather than persisting on a near-invisible mesh.
- [ ] Select a column on **Schemes**, then switch to **Sizing**. Expected: selection survives (column profile factor ≈ 1.0 on Sizing). Wireframe stays in place; the column itself takes its D/C color; the rest of the model shows D/C colors and is dimmed by the selection factor on top.
- [ ] On **Sizing** with a column selected: click empty space to clear selection. Expected: every mesh restores to its page-mode opacity *and* keeps its D/C color (color overlay is independent of opacity dimming).
- [ ] Click rapidly: column A → column B → empty space → column A → empty space. Expected: each step animates smoothly; no opacity drift; final state matches the page-mode baseline.

## Layout

- [ ] Inspector panel is fully visible on Placement, Schemes, Sizing — never clipped or pushed off-screen.
- [ ] Resizing the browser window keeps the canvas inside its column; the inspector width stays at `--inspector-width`.
- [ ] Switching between 2D and 3D leaves no leftover Three.js DOM elements (no orphan `canvas`, no orphan `.three-grid-overlay`).

## Stability & cleanup

- [ ] Switching projects and re-mounting the canvas does not stack geometry — the previous scene is fully cleared before the next one renders.
- [ ] Calling `viewport.applyParsedGeometry(newPayload)` twice in a row produces only one set of meshes (no doubling). `buildFromParsedGeometry` calls `clearAll()` internally so geometry never accumulates.
- [ ] DevTools → Memory: no Three.js disposed-object warnings in the console after navigating away from a canvas page.
- [ ] DevTools → Console: no errors thrown when:
    - the fixture loads,
    - a malformed geometry payload is supplied (one bad NCZ polygon should produce a console warning, not a crash),
    - the Three host is unmounted while a page-mode transition is mid-animation.
- [ ] If the API ever returns a `ParsedGeometry` with no levels, the viewer logs `[CivilAgent] Geometry could not be rendered: ...` and stays mounted (no white screen / hard crash).

## Visual quality

- [ ] No shadows are rendered anywhere on screen (`renderer.shadowMap.enabled === false`, no `castShadow` in the scene).
- [ ] Slab colors look "reading-room concrete" — neutral and matte, not glossy.
- [ ] Ground plane is subtle. Building does not look like it's floating in pure black void *or* sitting on a bright stage.
- [ ] Grid labels never overlap each other at default zoom and remain readable when zoomed in to 2× and out to 0.5×.

## Smoke run-through

1. Open the workspace at the **Overview** page.
2. Navigate Geometry → Placement → Loads → Schemes → Sizing in sequence.
3. On each page: rotate the camera once, click one element, click empty space.
4. Switch to 2D. Scroll the SVG view. Switch back to 3D.
5. Open the layer popover and toggle every layer off then on.
6. Open browser devtools and confirm: no errors, no warnings, no growing `THREE.WebGLRenderer` count between page switches.

If every item checks out, Agent 2 is good to ship.

## End-to-end with Agent 1 (live API)

These items only apply when `docker compose up` is running locally —
i.e. the FastAPI service is reachable at `http://localhost:8000`. With
the API down everything below should silently degrade to the existing
mock pipeline (the front-end probes `/health` first).

- [ ] Open `#/new` and fill the project name, location, and building
      type. The Create button enables.
- [ ] Drag in a `.ifc` (or `.dxf` / `.dwg` / `.pdf`) and watch the file
      row's status field cycle through "Preparing upload" → "Uploading"
      → "Registering" → "Uploaded — queued for parsing".
- [ ] Click **Create project**. The processing screen header reads
      "Parsing · NN%". The step list shows the canonical Agent 1 steps:
      download → init → levels → grids → cores → openings → floor_plates
      → existing_elements → no_column_zones → validation → complete.
- [ ] When parsing completes the CTA changes to "Open workspace →".
      Clicking it lands on `#/p/<uuid>/geometry` and the 3D viewer renders
      the *real* parsed geometry (not the fixture).
- [ ] If parsing fails (e.g. corrupt PDF) the CTA becomes "Back to projects".
      No workspace navigation happens. `state.newProject.processingError`
      is populated.
- [ ] Re-uploading the same file triggers the API's idempotency path
      (`status: "deduped"`) — the parse completes near-instantly and no
      second worker job runs.

If you don't have the API running, the legacy mock pipeline still
fires. Both code paths share the same `processing.js` rendering, so any
visual regression is visible in either mode.
