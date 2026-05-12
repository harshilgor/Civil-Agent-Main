# CivilAgent — Agent 1 (IFC Geometry Parser)

Production-grade Python backend that turns uploaded building files
(IFC / DXF / DWG / PDF) into the canonical `ParsedGeometry` JSON
contract consumed by the existing CivilAgent frontend and every
downstream agent.

```
civilagent/
├── apps/
│   ├── api/         # FastAPI — REST + WebSocket
│   └── worker/      # ARQ worker — parse jobs
├── packages/
│   └── engine/
│       └── geometry_parser/
│           ├── models.py        # canonical contract (Pydantic)
│           ├── parser.py        # orchestrator
│           ├── formats/         # ifc, dxf, dwg, pdf
│           ├── extractors/
│           ├── inference/
│           ├── validation.py
│           └── progress.py
├── docker/          # api + worker Dockerfiles
├── docker-compose.yml
├── migrations/      # Alembic
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   └── fixtures/    # synthetic IFC + duck-typed mock model
└── docs/            # API.md, RUNBOOK.md
```

The existing vanilla-JS frontend (root-level `app.js`, `css/`, `js/`,
`index.html`) is untouched — it lives at the workspace root and is
served separately.

## Quickstart

```bash
cp .env.example .env
docker compose up --build
# API: http://localhost:8000   docs: /docs
# Metrics: http://localhost:8000/metrics
```

Run the migrations once on first boot:

```bash
docker compose exec api alembic upgrade head
```

## Test

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -m "unit or contract"
```

The IFC native fixture tests (`@pytest.mark.ifc`) require IfcOpenShell
to be importable; they auto-skip if not.

## Versioning

* `PARSER_VERSION` — output-affecting code changes bump this.
* `SCHEMA_VERSION` (`parsed_geometry@1.0.0`) — contract surface; bump
  on breaking change with migration notes.

See `docs/API.md` for the full contract and `docs/RUNBOOK.md` for
on-call procedures.
