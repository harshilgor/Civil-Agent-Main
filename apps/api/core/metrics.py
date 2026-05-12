"""Prometheus metric definitions — single source of truth.

Histograms use bucket edges chosen for the parsing SLA (p95 < 120s for
typical IFC) so the dashboards can reliably alert on regressions.
"""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Histogram

REGISTRY = CollectorRegistry()

PARSE_REQUESTS_TOTAL = Counter(
    "civilagent_parse_requests_total",
    "Total parse trigger requests received.",
    labelnames=("project_id_kind", "format", "outcome"),
    registry=REGISTRY,
)

PARSE_RUNS_TOTAL = Counter(
    "civilagent_parse_runs_total",
    "Total parse runs by terminal status.",
    labelnames=("status", "format"),
    registry=REGISTRY,
)

PARSE_DURATION_SECONDS = Histogram(
    "civilagent_parse_duration_seconds",
    "End-to-end parse duration.",
    labelnames=("status", "format"),
    buckets=(1, 5, 15, 30, 60, 90, 120, 180, 300, 600),
    registry=REGISTRY,
)

PARSE_STEP_DURATION_SECONDS = Histogram(
    "civilagent_parse_step_duration_seconds",
    "Per-step duration inside the parser.",
    labelnames=("step", "status", "format"),
    buckets=(0.1, 0.5, 1, 5, 15, 30, 60, 120, 300),
    registry=REGISTRY,
)

PARSE_TIMEOUTS_TOTAL = Counter(
    "civilagent_parse_timeouts_total",
    "Total parse jobs terminated by global timeout.",
    labelnames=("format",),
    registry=REGISTRY,
)

UPLOAD_PRESIGNED_TOTAL = Counter(
    "civilagent_upload_presigned_total",
    "Total presigned upload URLs issued.",
    labelnames=("format", "result"),
    registry=REGISTRY,
)

WS_CLIENTS_CONNECTED = Counter(
    "civilagent_ws_clients_connected_total",
    "WebSocket connection attempts (success or rejected).",
    labelnames=("result",),
    registry=REGISTRY,
)
