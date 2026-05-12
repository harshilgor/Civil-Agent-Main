# CivilAgent Agent 1 — Operational Runbook

Service: `civilagent.api`, `civilagent.worker`
Schema: `parsed_geometry@1.0.0`
Parser: `1.0.0`

---

## Dashboards / queries you should bookmark

* **Parse success rate (last 1h):**

  ```
  sum by (status) (rate(civilagent_parse_runs_total[1h]))
  ```
  Healthy bands:
  - `completed` ≥ 90%
  - `partial`   ≤ 8%
  - `failed`    ≤ 2%

* **p95 parse duration by format:**

  ```
  histogram_quantile(0.95, sum by (format, le) (rate(civilagent_parse_duration_seconds_bucket[15m])))
  ```
  SLA: p95 IFC < 120s for typical (≤ 50 MB) files.

* **Timeout rate:**

  ```
  rate(civilagent_parse_timeouts_total[15m])
  ```

* **WebSocket rejections:**

  ```
  rate(civilagent_ws_clients_connected_total{result!="accepted"}[15m])
  ```

---

## Logs

All logs are JSON. Key fields you can filter on:

| Field | Example | Source |
| --- | --- | --- |
| `service` | `civilagent.worker` | `apps/api/core/logging_config.py` |
| `event` | `parser.timeout` | structlog event key |
| `run_id` / `geometry_id` / `job_id` | UUIDs | bound on every parser log line |
| `step` | `floor_plates` | per-step extractor logs |
| `code` | `IFC_GEOMETRY_FAIL` | structured error code |

We **do not** log raw document contents — only metadata + hashed
identifiers. If a triage requires the file, pull from S3 using the
`s3_key` recorded in `project_files`.

---

## Common incidents

### 1. Stuck job — “processing” for > timeout

**Symptoms:** `parsed_geometries.parse_status='processing'`, no terminal
event on Redis, `civilagent_parse_timeouts_total` flat (so the job
never reached the timeout path).

**Diagnose:**

```sql
SELECT id, project_id, run_id, created_at, parser_version
FROM parsed_geometries
WHERE parse_status = 'processing'
  AND created_at < now() - interval '30 minutes';
```

**Resolve:**

1. Check ARQ queue depth: `redis-cli -n 0 llen arq:queue`. Backlog →
   scale workers.
2. Check worker logs for the job_id. If the worker died mid-job, ARQ
   will requeue once. If it died before emitting the terminal event,
   manually:

   ```sql
   UPDATE parsed_geometries
   SET parse_status='failed',
       failed_step='worker',
       failed_step_code='INTERNAL_ERROR',
       warnings = warnings || ARRAY['[INTERNAL_ERROR] step=runbook: manual close-out'],
       completed_at = now()
   WHERE id = '<geometry_id>';
   ```
3. Notify the engineer; tell them to re-trigger with `force=true`.

### 2. Redis outage

**Symptoms:** WebSocket clients drop, ARQ jobs stop firing,
`progress.sink_failure` log lines from the parser.

**Behaviour by design:** the parser swallows sink failures — the parse
itself completes and the DB row reflects the terminal state. The
frontend, however, will not see live progress and must fall back to
polling `GET /geometry/{id}` until WebSockets recover.

**Resolve:**

1. Restore Redis.
2. New parse triggers will flow normally.
3. In-flight parses already running will finish and persist correctly;
   their progress events for the outage window are lost.

### 3. S3 auth failure

**Symptoms:** `DOWNLOAD_FAIL` errors on the worker; presign requests
fail with `403`.

**Diagnose:**

```bash
aws s3 ls s3://$S3_BUCKET/ --endpoint-url $S3_ENDPOINT_URL
```

**Resolve:** rotate the IAM credentials in your secret manager and
restart the API + worker pods. If running with OIDC, check IRSA / pod
identity mappings.

### 4. Malformed-IFC spike (> 5%/min `IFC_GEOMETRY_FAIL`)

**Symptoms:** `civilagent_parse_runs_total{status="failed"}` jumps,
warnings carry `IFC_GEOMETRY_FAIL`.

**Diagnose:** group by `failed_step_code` over recent rows:

```sql
SELECT failed_step_code, count(*)
FROM parsed_geometries
WHERE created_at > now() - interval '15 minutes'
GROUP BY 1 ORDER BY 2 DESC;
```

**Resolve:**

* If concentrated on a single tenant → likely a vendor-specific export
  variant; pull the file, reproduce locally, file a parser bug ticket
  with the IFC fixture attached.
* If across tenants → check IfcOpenShell version; a transient native
  lib upgrade in the base image can cause regressions. Roll back to the
  previous container tag (`civilagent-worker:<previous>`).

### 5. Vision quota exhausted (raster PDFs)

**Symptoms:** `PDF_VISION_FAIL` on every raster PDF.

**Resolve:** raster PDFs are non-essential v1 paths. The parser already
emits a graceful empty result with `PDF_VISION_KEY_MISSING` /
`PDF_VISION_FAIL`. If quota recovery takes time, communicate the
degradation to customers; vector PDFs and IFC/DXF continue to work.

### 6. JWKS / IdP outage

**Symptoms:** every authenticated request returns `401`
`AUTH_JWKS_FETCH_FAILED`.

**Diagnose:**

* `curl -sS $AUTH_JWKS_URL` from inside the API pod — must return a
  `keys` JSON document.
* Check the IdP status page (Auth0 status, Clerk status).

**Resolve:**

1. If the IdP is healthy, the issue is network egress — check egress
   rules / WAF.
2. The JWKS document is cached for `AUTH_JWKS_CACHE_TTL_SECONDS`
   (default 15 m). Existing tokens with cached keys keep working until
   the cache expires; new pods cannot fetch keys until egress recovers.
3. Once recovered, no manual action — the verifier auto-loads on the
   next request.

### 7. JWT signing-key rotation surprise

**Symptoms:** sudden burst of `AUTH_KID_UNKNOWN`.

**Behaviour by design:** the verifier auto-refreshes the JWKS once on a
`kid` cache miss before failing. If you see this code, the IdP rotated
keys and the cache TTL hadn't elapsed *and* the IdP isn't serving the
new `kid` yet (or stripped the old one).

**Resolve:** ask the IdP to publish both old and new keys for at least
the cache TTL window. Reduce `AUTH_JWKS_CACHE_TTL_SECONDS` if your
provider rotates aggressively.

### 8. Parse `partial` rate jumps with `failedStepCode=TIMEOUT`

**Symptoms:** `civilagent_parse_timeouts_total` rising;
`parsed_geometries.failed_step_code='TIMEOUT'` over recent window.

**Behaviour by design:** CPU-heavy extractor steps run via
`asyncio.to_thread`, so the global `PARSE_TIMEOUT_SECONDS` deadline
*always* returns a partial result on time. The underlying thread keeps
running to completion in the background. This means a single very
large IFC file can leave one orphan thread per affected job — the
process is still healthy, but worker memory may climb until the thread
exits.

**Resolve:**

1. If memory is fine, no action — partial results are returned to the
   engineer and they can re-trigger with `force=true` once the file is
   simplified or split.
2. If memory is climbing, scale workers horizontally (each ARQ worker
   process has its own thread pool) and consider splitting offending
   IFC files at the storey level before upload.

---

## State surgery

> Be conservative. State changes are auditable: every row carries
> `parser_version`, `schema_version`, `run_id`, `accepted_by`,
> `accepted_at`. Manual edits should be logged in your incident
> tracker.

### Re-open an accepted geometry

```sql
UPDATE parsed_geometries
SET review_status='pending', accepted_at=NULL, accepted_by=NULL
WHERE id='<geometry_id>';
```

### Force-supersede a stuck accepted row

```sql
UPDATE parsed_geometries
SET review_status='superseded'
WHERE project_id='<project>'
  AND review_status='accepted'
  AND id <> '<latest_completed_geometry_id>';
```

### Replay a parse for QA

Triggering a parse with `force=true` always creates a new geometry id.
Use the new id in your QA harness; the previously-accepted row remains
the canonical answer until the new one is accepted.

---

## Capacity hints

* Worker memory: ≥ 2 GB per process — IFC geometry parsing peaks
  during slab unioning.
* CPU: 1 vCPU per worker process; scale horizontally rather than
  vertically (no shared global state in the parser).
* Postgres: index hot paths are
  `(project_id, parse_status)` and `(project_id, review_status)`,
  already created in migration `0001_initial`.
* Redis: pub/sub is ephemeral; the state-snapshot keys
  (`parse-progress:state:{id}`) expire after 24 h.

---

## Release checklist

Before promoting `worker:<new-tag>` to prod:

1. Run `pytest -m "unit or contract"` locally — all green.
2. Build container image; verify it boots: `docker run civilagent-worker --help`.
3. Smoke-test against staging by uploading the synthetic-IFC fixture
   (see `tests/fixtures/synthetic_ifc.py`).
4. Confirm `PARSER_VERSION` was bumped if any output-affecting code
   changed (otherwise idempotency keys collide with the previous version).
5. Watch the rollout for 30 minutes; check the parse success rate.
