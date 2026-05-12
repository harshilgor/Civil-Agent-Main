"""Add member sizing tables (Agent 4).

Revision ID: 0004_member_sizing
Revises: 0003_schemes_and_audit
Create Date: 2026-05-02 13:30:00.000000

Agent 4 — the load calculator + member sizer — persists three new
artifacts:

* ``member_checks`` — one row per failure-mode evaluation (flexure,
  shear, deflection_live, deflection_total for beams; axial_compression
  + optional slenderness for columns). The governing check has
  ``governing=true``; reviewers expect to filter by that.
* ``column_takedowns`` — per-level cumulative load history for every
  column. Top-to-bottom auditable trail of the gravity takedown.
* ``project_assumptions`` — per-project engineer overrides for the
  default load + material parameters. Sole row per project; UPSERT on
  insert.

Plus a few columns on ``schemes`` itself so the API can surface the
calculation lifecycle without joining:

* ``sizing_status`` — 'unsized' | 'calculating' | 'sized' | 'failed'
* ``sizing_run_id`` — UUID of the most recent calculate job
* ``sized_at`` — wall-clock timestamp of the last successful sizing

Recalculation policy: when a new sizing job runs for a scheme, the
worker DELETEs every prior member_checks / column_takedowns row for
that scheme_id before INSERTing the new ones. That keeps the data
self-consistent (no half-old, half-new mixed result sets). The
``ON DELETE CASCADE`` from ``schemes`` handles scheme archival
automatically.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004_member_sizing"
down_revision = "0003_schemes_and_audit"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # member_checks
    # ------------------------------------------------------------------
    op.create_table(
        "member_checks",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "scheme_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("schemes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("member_id", sa.String(64), nullable=False),
        sa.Column("member_type", sa.String(20), nullable=False),
        sa.Column("selected_size", sa.String(30), nullable=False),
        sa.Column("check_type", sa.String(40), nullable=False),
        sa.Column("demand", sa.Float, nullable=False),
        sa.Column("capacity", sa.Float, nullable=False),
        sa.Column("dcr", sa.Float, nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column(
            "governing",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("load_combination", sa.String(64), nullable=True),
        sa.Column("explanation", sa.Text, nullable=True),
        sa.Column("demand_unit", sa.String(20), nullable=True),
        sa.Column("capacity_unit", sa.String(20), nullable=True),
        sa.Column(
            "warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_member_checks_scheme", "member_checks", ["scheme_id"]
    )
    op.create_index(
        "idx_member_checks_member", "member_checks", ["member_id"]
    )
    op.create_index(
        "idx_member_checks_governing",
        "member_checks",
        ["scheme_id", "governing"],
    )

    # ------------------------------------------------------------------
    # column_takedowns
    # ------------------------------------------------------------------
    op.create_table(
        "column_takedowns",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "scheme_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("schemes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("column_id", sa.String(64), nullable=False),
        sa.Column("level_id", sa.String(40), nullable=False),
        sa.Column("level_name", sa.String(120), nullable=True),
        sa.Column("level_index_from_top", sa.Integer, nullable=False),
        sa.Column("tributary_area_sf", sa.Float, nullable=False),
        sa.Column("cumulative_tributary_area_sf", sa.Float, nullable=False),
        sa.Column("dead_load_kip", sa.Float, nullable=False),
        sa.Column("live_load_kip", sa.Float, nullable=False),
        sa.Column("live_load_unreduced_kip", sa.Float, nullable=False),
        sa.Column("reduction_factor", sa.Float, nullable=False),
        sa.Column("factored_load_kip", sa.Float, nullable=False),
        sa.Column("governing_combination", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("idx_takedown_scheme", "column_takedowns", ["scheme_id"])
    op.create_index("idx_takedown_column", "column_takedowns", ["column_id"])
    op.create_index(
        "idx_takedown_scheme_column",
        "column_takedowns",
        ["scheme_id", "column_id"],
    )

    # ------------------------------------------------------------------
    # project_assumptions
    # ------------------------------------------------------------------
    op.create_table(
        "project_assumptions",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "assumptions_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("project_id", name="uq_project_assumptions_project"),
    )

    # ------------------------------------------------------------------
    # schemes — lifecycle columns for the sizing workflow
    # ------------------------------------------------------------------
    op.add_column(
        "schemes",
        sa.Column(
            "sizing_status",
            sa.String(20),
            nullable=False,
            server_default="unsized",
        ),
    )
    op.add_column(
        "schemes",
        sa.Column(
            "sizing_run_id",
            postgresql.UUID(as_uuid=False),
            nullable=True,
        ),
    )
    op.add_column(
        "schemes",
        sa.Column(
            "sized_at",
            sa.TIMESTAMP(timezone=True),
            nullable=True,
        ),
    )
    op.create_index("idx_schemes_sizing_status", "schemes", ["sizing_status"])


def downgrade() -> None:
    op.drop_index("idx_schemes_sizing_status", table_name="schemes")
    op.drop_column("schemes", "sized_at")
    op.drop_column("schemes", "sizing_run_id")
    op.drop_column("schemes", "sizing_status")

    op.drop_table("project_assumptions")

    op.drop_index("idx_takedown_scheme_column", table_name="column_takedowns")
    op.drop_index("idx_takedown_column", table_name="column_takedowns")
    op.drop_index("idx_takedown_scheme", table_name="column_takedowns")
    op.drop_table("column_takedowns")

    op.drop_index("idx_member_checks_governing", table_name="member_checks")
    op.drop_index("idx_member_checks_member", table_name="member_checks")
    op.drop_index("idx_member_checks_scheme", table_name="member_checks")
    op.drop_table("member_checks")
