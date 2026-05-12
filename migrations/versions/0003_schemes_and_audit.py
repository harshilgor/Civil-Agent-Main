"""Add schemes + audit_log tables (Agent 3).

Revision ID: 0003_schemes_and_audit
Revises: 0002_parse_options
Create Date: 2026-05-02 00:00:00.000000

The column-layout generator (Agent 3) persists each generated variant
as a row in ``schemes``. An ``audit_log`` table — greenfield in this
migration — captures who triggered generation and which scheme they
activated, so every column-placement decision is traceable to a user
+ timestamp.

Regeneration policy: when a new ``POST /schemes/generate`` succeeds,
all prior schemes for the same ``geometry_id`` are flipped to
``status='archived'`` (handled by the worker, not the migration).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003_schemes_and_audit"
down_revision = "0002_parse_options"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---------------------------------------------------------------
    # schemes — one row per generated variant
    # ---------------------------------------------------------------
    op.create_table(
        "schemes",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "geometry_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("parsed_geometries.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("display_label", sa.String(4), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("strategy", sa.String(50), nullable=False),
        sa.Column("description", sa.Text, nullable=False, server_default=""),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="alternate",
        ),
        sa.Column(
            "columns_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
        sa.Column(
            "beams_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
        sa.Column(
            "shear_walls_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
        sa.Column(
            "braces_data",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="[]",
        ),
        sa.Column(
            "metrics",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("score", sa.Float, nullable=True),
        sa.Column(
            "constraints_used",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "generation_run_id",
            postgresql.UUID(as_uuid=False),
            nullable=True,
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
    )
    op.create_index("idx_schemes_project", "schemes", ["project_id"])
    op.create_index("idx_schemes_geometry", "schemes", ["geometry_id"])
    op.create_index("idx_schemes_run", "schemes", ["generation_run_id"])

    # ---------------------------------------------------------------
    # audit_log — greenfield table (did not exist prior to Agent 3)
    # ---------------------------------------------------------------
    op.create_table(
        "audit_log",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(50), nullable=False),
        sa.Column("user_id", sa.String(255), nullable=True),
        sa.Column(
            "payload",
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
    )
    op.create_index("idx_audit_project", "audit_log", ["project_id"])
    op.create_index("idx_audit_event", "audit_log", ["event_type"])


def downgrade() -> None:
    op.drop_index("idx_audit_event", table_name="audit_log")
    op.drop_index("idx_audit_project", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_index("idx_schemes_run", table_name="schemes")
    op.drop_index("idx_schemes_geometry", table_name="schemes")
    op.drop_index("idx_schemes_project", table_name="schemes")
    op.drop_table("schemes")
