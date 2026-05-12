# CivilAgent API — Agent 1 (Geometry Parser)

> Schema version: `parsed_geometry@1.0.0`  ·  Parser version: `1.0.0`

## Authentication

Every REST + WebSocket endpoint requires an authenticated principal that
carries a `(user_id, org_id)` pair. Every request is authorised against
the `Project` row's `org_id`; cross-tenant access returns **404**, never
403, so existence is never leaked.

### REST

| Header | Production | Local dev |
| --- | --- | --- |
| `Authorization: Bearer <jwt>` | required | optional |
| `X-Dev-User`, `X-Dev-Org` | rejected | accepted when `AUTH_DEV_BYPASS=true` AND `CIVILAGENT_ENV ∈ {local, dev}` |

JWTs are verified against the IdP's JWKS endpoint
(`AUTH_JWKS_URL`):

* Algorithm allow-list (`AUTH_JWT_ALGORITHMS`, default `RS256,ES256`)
  rejects `alg=none`, `HS*`, and unknown algs.
* `aud` and `iss` validated against `AUTH_JWT_AUDIENCE` and
  `AUTH_JWT_ISSUER`.
* `exp`, `iat`, `sub` are required; `org_id` (or `org` / `azp`) maps to
  the principal's tenant. The org-claim name is configurable
  (`AUTH_JWT_ORG_CLAIM`).
* JWKS is cached for `AUTH_JWKS_CACHE_TTL_SECONDS` (default 15 minutes)
  with single-shot rotation refresh on `kid` cache misses.
* Verified verifier configurations: Auth0, Clerk, any standard
  RFC-7517 JWKS endpoint.

Stable error codes (all `401`):
`AUTH_MISSING_TOKEN`, `AUTH_TOKEN_EXPIRED`, `AUTH_AUDIENCE_INVALID`,
`AUTH_ISSUER_INVALID`, `AUTH_SIGNATURE_INVALID`, `AUTH_KID_UNKNOWN`,
`AUTH_ALG_INVALID`, `AUTH_MISSING_KID`, `AUTH_MISSING_SUB`,
`AUTH_MISSING_ORG`, `AUTH_NOT_CONFIGURED`, `AUTH_JWKS_FETCH_FAILED`,
`AUTH_JWKS_INVALID`, `AUTH_MALFORMED_TOKEN`, `AUTH_TOKEN_INVALID`.

### WebSocket

Browsers cannot set `Authorization` on WS handshakes, so the token is
passed via `?token=<jwt>` (query string). The same JWKS verification
runs. Dev mode honours the same `X-Dev-User` / `X-Dev-Org` headers as
REST. Auth failure closes the socket with code
`1008` (policy violation).

## Error envelope

Every error response uses a stable envelope:

```json
{
  "code": "PROJECT_NOT_FOUND",
  "message": "Project not found.",
  "context": { }
}
```

`code` values are stable across releases — alerts/runbooks refer to
codes, not free-text. The full taxonomy is in
`packages/engine/geometry_parser/errors.py` (parser side) and
`apps/api/core/errors.py` (HTTP side).

---

## Upload flow

1. **Create presigned URL**

   `POST /api/projects/{project_id}/files/upload-url`

   Body:
   ```json
   { "filename": "tower-one.ifc", "contentType": "application/x-step" }
   ```
   Returns `201`:
   ```json
   {
     "fileId": "uuid",
     "presignedUrl": "https://s3...",
     "expiresInSeconds": 900,
     "s3Key": "orgs/{org}/projects/{project}/uploads/{file}.ifc",
     "maxBytes": 524288000
   }
   ```
   - Content-type is validated against the extension via a strict
     allow-list (`FORMAT_NOT_ALLOWED`, `CONTENT_TYPE_MISMATCH`).
   - The presigned URL TTL comes from `S3_PRESIGN_TTL_SECONDS`
     (default 900s).

2. **Upload directly to S3** (frontend → S3, API never touches bytes).

3. **Confirm upload + register hash**

   `POST /api/projects/{project_id}/files/{file_id}/registered`

   Body:
   ```json
   { "fileId": "uuid", "fileSize": 123456, "sha256": "..." }
   ```
   Returns `204`. The hash is required before triggering a parse — it
   anchors the idempotency key.

---

## Parse trigger

`POST /api/projects/{project_id}/geometry/parse`

Body:
```json
{
  "fileId": "uuid",
  "force": false,
  "options": { "pageNumber": 2 }   // optional, PDFs only
}
```

Returns `202`:
```json
{
  "jobId": "uuid",
  "geometryId": "uuid",
  "status": "queued",        // or "deduped"
  "idempotencyKey": "sha256-hex"
}
```

### Parse options

| Field | Type | Behaviour |
| --- | --- | --- |
| `pageNumber` | `int ≥ 1` (PDF only) | Parse only this page; treat as a single `Level`. Omit for vector PDFs to parse every page (one `Level` per page). Ignored for IFC/DXF/DWG and dropped from the idempotency key for those formats. |

### Idempotency

The dedupe key is

```
sha256(project_id | file_sha256 | parser_version | "opts=" + canonical(options))
```

* Same file + same options → same `geometryId`, response `status=deduped`.
* Same file, different `options.pageNumber` → **different** key, separate
  jobs and `geometryId`s. (Page 1 and Page 7 of the same PDF must not
  alias.)
* Set `force=true` to bypass dedupe entirely; a random `force_token` is
  mixed into the key, producing a fresh run.

---

## Geometry retrieval

| Endpoint | Returns |
| --- | --- |
| `GET /api/projects/{project_id}/geometry` | latest accepted → completed → partial → processing → failed (precedence documented at `apps/api/routers/geometry.py::_resolve_latest`). |
| `GET /api/projects/{project_id}/geometry/{geometry_id}` | immutable snapshot for that version. |
| `PATCH /api/projects/{project_id}/geometry/{geometry_id}/accept` | sets `reviewStatus=accepted`, supersedes the prior accepted row, records `acceptedAt` + `acceptedBy`. |

Acceptance state machine:

```
parse_status: processing → completed | partial | failed
review_status: pending → accepted → superseded
```

| Transition | Allowed when |
| --- | --- |
| accept | `parse_status ∈ {completed, partial}` AND `review_status == pending` |

Any other accept attempt returns `409 INVALID_STATE_TRANSITION`.

---

## WebSocket — progress

`WS /ws/parse-progress/{geometry_id}`

* The connection is rejected (`WS 1008`) if the principal's org doesn't
  own the geometry's project.
* On connect, the server replays the last cached snapshot from Redis
  (`parse-progress:state:{geometry_id}`) so reconnecting clients catch
  up without re-running the parse.
* While the job runs, every step emits a `ProgressEvent`:

  ```json
  {
    "jobId": "uuid",
    "geometryId": "uuid",
    "step": "levels",
    "status": "in_progress",
    "detail": "8 levels found",
    "substeps": [
      {"name": "download", "status": "complete", "detail": "...", "durationMs": 312},
      {"name": "init", "status": "complete", "detail": "..."},
      {"name": "levels", "status": "in_progress", "detail": null}
    ],
    "progress": 0.30,
    "timestamp": "2026-05-01T14:22:03Z",
    "terminal": false,
    "errorCode": null
  }
  ```

* `substeps` is a **full snapshot** every event — replace, don't merge.
* `progress` is monotonic non-decreasing per job; reaches `1.0` only on
  the terminal event.
* Exactly **one** terminal event is emitted per job
  (`status ∈ {completed, partial, failed, timeout}`). After that the
  socket is closed with `WS 1000`.
* Heartbeat frames (`{"type":"heartbeat"}`) are sent every 15s when
  there's no traffic.

---

## ParsedGeometry schema

Defined by `packages/engine/geometry_parser/models.py`. Required (always
present) keys: `levels`, `gridLines`, `cores`, `buildingBounds`,
`metadata`. Empty arrays are valid; missing-data is communicated via
warnings, never via missing keys.

Every inferred value (i.e. anything not directly read from the file)
carries `confidence ∈ [0, 1]`, `source` (`ifc | inferred | dxf | pdf | vision`),
and a `rationale` string explaining how it was derived.

`metadata` always includes:

| Field | Description |
| --- | --- |
| `schemaVersion` | locked to `parsed_geometry@1.0.0` for v1 |
| `parserVersion` | matches the running parser image |
| `runId` | unique per parse attempt |
| `fileFormat` | `ifc | dxf | dwg | pdf` |
| `fileHash` | SHA-256 of source bytes |
| `originTransform` | `{tx, ty, units, rotation_rad}` — reverses local→global |
| `status` | `processing | completed | partial | failed` |
| `completedSteps` | ordered list of step names that succeeded |
| `failedStep`, `failedStepCode` | populated when `status != completed` |
| `warnings` | structured strings of the form `[CODE] step=...: detail` |
| `layerMapping` | DXF only — `{layer_name: classification}` |
| `parsedAt` | ISO-8601 UTC |
| `durationMs` | end-to-end duration |
| `sourceFileId` | FK back to `project_files` row |

---

---

# Agent 3 — Column Layout Generator

> Schema version: `structural_scheme@1.0.0` · Generator version: `1.0.0`

Agent 3 turns a `ParsedGeometry` into a list of 4–5 `StructuralScheme`
variants. The engine is purely algorithmic (constraint satisfaction —
no AI/ML), runs in the worker (never inline on the request thread),
and writes its results to two new tables: `schemes` (one row per
variant) and `audit_log` (one row per generation / activation /
archive event).

**Sizing-dependent fields are always `null` from Agent 3.**
`steelTonnage`, `costIndex`, `maxDrift`, `maxBeamDepth`,
`uniqueSections` on `metrics`, and `size` / `dcr` / `status` on
each member, are populated by Agent 4 (member sizing). Renderers
must tolerate nulls — the canvas falls back to neutral materials
and the inspector shows "—".

## Generate schemes

```
POST /api/projects/{projectId}/schemes/generate
```

Body (all fields optional):

```json
{
  "geometryId": "uuid",            // omit → use latest accepted geometry
  "constraints": {
    "materialSystem": "steel_composite",
    "minBay": 25,
    "targetBay": 30,
    "maxBay": 45,
    "gridRegularityPreference": 0.7,
    "lockedColumnIds": ["col-1", "col-2"],
    "strategies": ["balanced", "minimum_columns", "short_span", "offset_grid", "long_span"]
  }
}
```

Response (`202 Accepted`):

```json
{
  "jobId": "uuid",
  "geometryId": "uuid",
  "generationRunId": "uuid",
  "status": "queued"
}
```

The worker:

1. Archives every non-archived scheme for that `geometryId` (sets
   `status = "archived"` in a single update so the regeneration is
   atomic from the API's perspective).
2. Runs the generator. Each strategy yields one variant with
   columns, beams, empty `shearWalls` / `braces`, and metrics.
3. Inserts the new variants under the fresh `generationRunId` with
   display labels `A`–`E` assigned in score order.
4. Writes `scheme_generation_complete` (or `scheme_generation_error`)
   to `audit_log`.

Progress is streamed over the same WebSocket channel as parsing
(`/ws/parse-progress/{geometryId}`); steps include
`scheme_balanced`, `scheme_minimum_columns`, `scheme_short_span`,
`scheme_offset_grid`, `scheme_long_span`, `scoring`, `complete`.

Stable error codes:

| Code | Meaning |
| --- | --- |
| `PROJECT_NOT_FOUND` | Project missing or owned by another tenant |
| `GEOMETRY_NOT_FOUND` | `geometryId` doesn't exist or isn't visible to the project |
| `GEOMETRY_NOT_READY` | Geometry hasn't reached `completed` status yet |
| `INVALID_CONSTRAINTS` | Constraint payload failed validation |
| `WORKER_ENQUEUE_FAILED` | ARQ rejected the job (Redis down, etc.) |

## List schemes

```
GET /api/projects/{projectId}/schemes
GET /api/projects/{projectId}/schemes?geometry_id={uuid}
GET /api/projects/{projectId}/schemes?include_archived=true
```

Returns the most recent generation run for the project (or for the
specified `geometry_id`). Archived schemes are filtered out by
default; pass `include_archived=true` to view the audit trail.

```json
{
  "schemes": [
    {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "displayLabel": "A",
      "name": "Balanced Strategy",
      "strategy": "balanced",
      "description": "Regular grid with 30ft bays, columns avoid all no-column zones",
      "status": "active",
      "score": 86.4,
      "columns": [
        {
          "id": "C-a1b2c3d4",
          "gridLabel": "A-1",
          "x": 0, "y": 0,
          "startLevel": "L1", "endLevel": "L8",
          "locked": false,
          "source": "generated",
          "size": null, "dcr": null, "status": null,
          "axialLoad": null, "tributaryArea": null
        }
      ],
      "beams": [
        {
          "id": "B-e5f6g7h8",
          "start": {"x": 0, "y": 0},
          "end":   {"x": 30, "y": 0},
          "levelId": "L6",
          "span": 30,
          "size": null, "dcr": null, "status": null
        }
      ],
      "shearWalls": [],
      "braces": [],
      "metrics": {
        "columnCount": 42,
        "maxSpan": 31.8,
        "averageSpan": 29.2,
        "uniqueBayPatterns": 3,
        "warningCount": 2,
        "warnings": [
          "Column C-a1b2c3d4 at 2.3ft from core boundary",
          "Bay D-3/4 exceeds 35ft span"
        ],
        "steelTonnage": null,
        "costIndex": null,
        "maxDrift": null,
        "maxBeamDepth": null,
        "uniqueSections": null,
        "concreteVolume": null
      }
    }
  ],
  "geometryId": "uuid",
  "generationRunId": "uuid"
}
```

The list is sorted by `score` descending. Exactly one scheme has
`status = "active"`; all others are `alternate`.

## Get a single scheme

```
GET /api/projects/{projectId}/schemes/{schemeId}
```

Returns the same shape as a single element of the list endpoint.
Shapes are stable — clients can cache by `id` indefinitely until
regeneration replaces it.

## Activate a scheme

```
PATCH /api/projects/{projectId}/schemes/{schemeId}
{ "status": "active" }
```

Only `status: "active"` is accepted. The server demotes any other
active scheme on the same `geometryId` to `alternate` in the same
transaction (so there is always exactly one active scheme per
geometry) and writes a `scheme_activated` row to `audit_log`. Other
status transitions (`alternate`, `archived`) go through `DELETE` or
regeneration — there's no general-purpose status writer.

## Archive a scheme

```
DELETE /api/projects/{projectId}/schemes/{schemeId}
```

Soft-delete — sets `status = "archived"` and writes `scheme_archived`
to `audit_log`. Archived schemes never appear in the default list
response; they remain in the database for compliance / auditing and
can be retrieved with `?include_archived=true`.

## StructuralScheme schema

Defined by `packages/engine/column_generator/models.py`. The API
serialises with `model_dump(by_alias=True)` so keys are camelCase
on the wire.

### Braces

`braces` is part of the schema for forward compatibility but is
**always `[]` in Agent 3 output**. The lateral-system agent is a
separate workstream.

### Shear walls

The Python model represents a shear wall as a centerline segment
(`start`, `end`) plus thickness. Agent 3 always emits an empty list
today; when the lateral agent populates it, `scheme-adapter.js`
expands the segment + thickness into a 4-point boundary polygon
before handing it to the 3D builder.

### Coordinate frame

Scheme `x` / `y` are in the **same plan frame as
`buildingBounds` / `levels[].planBoundary`** in the geometry. The
worker never bakes `originTransform` into stored coordinates —
`scheme-adapter.js` applies the transform exactly once at render
time. If `buildingBounds.minX` is 0 in the geometry, a column at
the left building edge has `x = 0` in the scheme output.

## Audit events

The `audit_log` table is created in the same migration as `schemes`
and is the system-of-record for any scheme-related action:

| `event_type` | Trigger | `payload` keys |
| --- | --- | --- |
| `scheme_generation` | `POST /generate` accepted | `geometryId`, `generationRunId`, `constraints`, `requestedStrategies` |
| `scheme_generation_complete` | Worker job finished | `geometryId`, `generationRunId`, `schemeCount`, `durationMs` |
| `scheme_generation_error` | Worker job raised | `geometryId`, `generationRunId`, `errorCode`, `message` |
| `scheme_activated` | `PATCH …/{id}` set active | `schemeId`, `previousActiveId`, `geometryId` |
| `scheme_archived` | `DELETE …/{id}` | `schemeId`, `geometryId` |

Every row carries `project_id`, `user_id` (from the auth context),
and `created_at`. There are no PUT/DELETE on `audit_log` — it is
append-only.

---

# Agent 4 — Load Calculator + Member Sizer

> Schema version: `member_sizing@1.0.0` · Sizer version: `1.0.0`

Agent 4 takes one of Agent 3's `StructuralScheme` variants, applies
gravity loads per ASCE 7 (with live load reduction), and sizes every
beam and column from the AISC W-shape catalog using LRFD methodology.

The engine is purely deterministic — same scheme + same assumptions
always produce the same `(selectedSize, dcr, governingCheck)` for
every member. There is no AI/ML in this layer. The output is
auditable end-to-end: every check carries a human-readable explanation
field that traces tributary width → uniform load → moment / shear /
axial / deflection demand → AISC capacity → D/C ratio.

**Scope (v1):**

* Steel only, bare W-shapes (no composite deck action — conservative).
* Gravity loads only (no lateral, wind, seismic, or P-Δ).
* Simply supported beams (pinned-pinned), uniform loading.
* Columns sized for the worst factored axial load over the full
  height (no stepping). `K = 1.0` for pinned-pinned unbraced length.
* Connections, foundations, ponding, and notional loads are not
  evaluated.
* `concreteVolume` and `maxDrift` on `metrics` stay `null` — they
  require a concrete agent and lateral analysis respectively.

## Calculate sizing

```
POST /api/projects/{projectId}/schemes/{schemeId}/calculate
```

Body (all fields optional):

```json
{
  "assumptions": {
    "deadLoadPsf": 75,
    "liveLoadPsf": 50,
    "roofDeadLoadPsf": 30,
    "roofLiveLoadPsf": 20,
    "fyKsi": 50,
    "eKsi": 29000,
    "beamLiveLoadDeflectionLimit": "L/360",
    "beamTotalLoadDeflectionLimit": "L/240",
    "roofLiveLoadDeflectionLimit": "L/240",
    "columnKFactor": 1.0,
    "beamSelfWeightPlf": 50
  }
}
```

The engine resolves assumptions in this order, falling through on
missing fields: **request body → `project_assumptions` row →
hard-coded defaults**. So the body can carry partial overrides
without losing project-level configuration.

Response (`202 Accepted`):

```json
{
  "jobId": "uuid",
  "schemeId": "uuid",
  "sizingRunId": "uuid",
  "status": "queued"
}
```

The worker:

1. Flips `schemes.sizing_status = "calculating"`.
2. Runs `calculate_scheme_sizing` (deterministic — same scheme + same
   assumptions ⇒ identical output).
3. Deletes any existing `member_checks` and `column_takedowns`
   rows for the scheme — recalculation policy is **fresh batch**,
   not incremental.
4. Inserts new `member_checks` (one row per failure-mode evaluation)
   and `column_takedowns` (one row per column-level pair).
5. Patches `schemes.metrics` with the Agent 4 fields (steelTonnage,
   maxBeamDepth, uniqueSections, costIndex). Agent 3's layout-only
   fields are preserved.
6. Flips `sizing_status = "sized"`, sets `sized_at`.
7. Writes `sizing_calculation_complete` (or
   `sizing_calculation_error`) to `audit_log`.

Stable error codes:

| Code | Meaning |
| --- | --- |
| `PROJECT_NOT_FOUND` | Project missing or owned by another tenant |
| `SCHEME_NOT_FOUND` | Scheme missing or not under that project |
| `SCHEME_EMPTY` | Scheme has no columns or no beams to size |
| `INVALID_ASSUMPTIONS` | Assumptions payload failed validation |
| `WORKER_ENQUEUE_FAILED` | ARQ rejected the job (Redis down, etc.) |

## Member summaries

```
GET /api/projects/{projectId}/schemes/{schemeId}/members
```

Returns the per-member rollup the canvas + inspector consume to
paint the D/C overlay and surface governing checks. Returns
`members: []` when the scheme has not been sized yet (callers
fall back to neutral materials and a "Run sizing" CTA).

```json
{
  "schemeId": "uuid",
  "sizingStatus": "sized",
  "sizingRunId": "uuid",
  "sizedAt": "2026-05-02T18:14:09Z",
  "members": [
    {
      "memberId": "B-e5f6g7h8",
      "memberType": "beam",
      "selectedSize": "W21x44",
      "weightPlf": 44,
      "dcr": 0.84,
      "governingCheck": "deflection_live",
      "status": "pass",
      "allChecks": [
        {
          "id": "uuid",
          "schemeId": "uuid",
          "memberId": "B-e5f6g7h8",
          "memberType": "beam",
          "selectedSize": "W21x44",
          "checkType": "flexure",
          "demand": 318.4,
          "capacity": 358.0,
          "dcr": 0.89,
          "status": "efficient",
          "governing": false,
          "loadCombination": "1.2D + 1.6L",
          "explanation": "Mu = 318.4 kip-ft; φMn = 0.9·Fy·Zx/12 = 358 kip-ft → DCR 0.89.",
          "demandUnit": "kip-ft",
          "capacityUnit": "kip-ft",
          "warnings": []
        }
      ]
    }
  ],
  "assumptionsUsed": { /* full SizingAssumptions payload echoed back */ },
  "warnings": ["B-12 deflection limit set by L/240; L/360 not enforced"]
}
```

## Member detail

```
GET /api/projects/{projectId}/schemes/{schemeId}/members/{memberId}
```

Per-member drill-down used by the inspector when the engineer
clicks a beam or column. Acceptable per-member API call because
it is user-initiated, not hovered.

```json
{
  "summary": { /* same shape as members[] entry above */ },
  "takedown": [
    {
      "columnId": "C-a1b2c3d4",
      "levelId": "L8",
      "levelName": "Roof",
      "levelIndexFromTop": 0,
      "tributaryAreaSf": 900,
      "cumulativeTributaryAreaSf": 900,
      "deadLoadKip": 67.5,
      "liveLoadKip": 18.0,
      "liveLoadUnreducedKip": 45.0,
      "reductionFactor": 0.40,
      "factoredLoadKip": 109.8,
      "governingCombination": "1.2D + 1.6L"
    }
  ]
}
```

`takedown` is empty for beams; for columns it lists every level
top → bottom with cumulative tributary area, unfactored DL/LL,
LLR factor at that level, and the governing factored load.

## Column takedowns (whole scheme)

```
GET /api/projects/{projectId}/schemes/{schemeId}/takedown
```

Returns all column takedowns grouped by column, in a single
payload — useful for the load-takedown overlay and report
generation:

```json
{
  "schemeId": "uuid",
  "columns": [
    {
      "columnId": "C-a1b2c3d4",
      "gridLabel": "A-1",
      "levels": [ /* ColumnTakedownEntry top → bottom */ ]
    }
  ]
}
```

## Project assumptions

The engineer can override default load values, deflection limits,
and material properties on a per-project basis. Stored in the
`project_assumptions` table (one row per project).

```
GET /api/projects/{projectId}/assumptions
```

Returns the stored row, or — when no row exists — a synthesised
payload with hard-coded defaults so the caller always sees the
exact values the calculator will use:

```json
{
  "projectId": "uuid",
  "assumptions": { /* SizingAssumptions, camelCase */ },
  "createdAt": "2026-05-02T16:00:00Z",
  "updatedAt": "2026-05-02T16:00:00Z"
}
```

```
PUT /api/projects/{projectId}/assumptions
```

Body:

```json
{ "assumptions": { "liveLoadPsf": 80, "deadLoadPsf": 90 } }
```

Upserts the row; missing fields fall back to defaults at engine
runtime. The response shape matches `GET`.

## WebSocket — sizing progress

`WS /ws/sizing-progress/{schemeId}`

Scheme-scoped (NOT geometry-scoped — two schemes for the same
geometry can be sized in parallel without their progress bars
cross-talking).

* Tenant isolation: the connection is rejected (`WS 1008`) if the
  principal's org doesn't own the scheme's project.
* On connect, the server replays the last cached snapshot from
  Redis (`sizing-progress:state:{schemeId}`) so a reconnecting
  client picks up where it left off.
* `ProgressEvent` shape mirrors the parser; `step` values are:

  | step | meaning |
  | --- | --- |
  | `init` | loading scheme + geometry + assumptions |
  | `tributary` | computing tributary widths/areas |
  | `beam_sizing` | iterating AISC beams (flexure, shear, deflection) |
  | `column_takedown` | accumulating axial loads + sizing columns |
  | `metrics` | rolling up steelTonnage, costIndex, etc. |
  | `persist` | writing rows to the database |
  | `complete` | terminal — emitted exactly once per job |

* Heartbeat frames (`{"type":"heartbeat"}`) sent every 15s when
  there's no traffic.
* Exactly **one** terminal event per job (`status ∈ {completed,
  failed}`). After that the socket closes with `WS 1000`.

## DCR thresholds + status alignment

Backend status strings match the frontend's `DCR_THRESHOLDS` in
`js/data/constants.js` exactly:

| `dcr` range | `status` | Color (frontend) |
| --- | --- | --- |
| `dcr ≤ 0` or null | `unsized` | gray |
| `0 < dcr < 0.85` | `pass` | green |
| `0.85 ≤ dcr < 0.95` | `efficient` | yellow |
| `0.95 ≤ dcr ≤ 1.00` | `near-capacity` | orange |
| `dcr > 1.00` | `fail` | red |

If the bands change on either side, `member_sizer/constants.py`
and `js/data/constants.js` MUST be updated together (and
`SIZER_VERSION` bumped so previously-stored audit rows aren't
silently misclassified).

## Audit events (Agent 4)

| `event_type` | Trigger | `payload` keys |
| --- | --- | --- |
| `sizing_calculation` | `POST /calculate` accepted | `schemeId`, `sizingRunId`, `assumptionsOverridden` |
| `sizing_calculation_complete` | Worker job finished | `schemeId`, `sizingRunId`, `beamCount`, `columnCount`, `steelTonnage`, `calculationTimeMs`, `warnings`, `sizerVersion` |
| `sizing_calculation_error` | Worker job raised | `schemeId`, `sizingRunId`, `errorCode`, `message` |
| `assumptions_updated` | `PUT /assumptions` | `projectId`, `changedKeys` |

---

## Health / metrics

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | parser/schema version + service status |
| `GET /metrics` | Prometheus exposition (counters + histograms) |

Important metrics:

| Metric | Type | Description |
| --- | --- | --- |
| `civilagent_parse_runs_total{status,format}` | counter | Terminal status by format |
| `civilagent_parse_duration_seconds{status,format}` | histogram | End-to-end latency, buckets up to 600s |
| `civilagent_parse_step_duration_seconds{step,status,format}` | histogram | Per-step latency |
| `civilagent_parse_timeouts_total{format}` | counter | Timed-out jobs |
| `civilagent_parse_requests_total{outcome,format,...}` | counter | Trigger requests by outcome (queued/deduped) |
| `civilagent_upload_presigned_total{format,result}` | counter | Presign issuance |
| `civilagent_ws_clients_connected_total{result}` | counter | WS connects (accepted/rejected) |

---

## Versioning + back-compat

* Schema additions remain backward compatible.
* Schema field renames or removals require a bump of `SCHEMA_VERSION`
  (e.g. `parsed_geometry@2.0.0`) plus a migration note in the changelog.
* Parser logic changes that affect *output* require a bump of
  `PARSER_VERSION` so the idempotency key changes and previously-cached
  results are not silently treated as up-to-date.
