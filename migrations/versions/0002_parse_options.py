"""Add parse_options JSON column to parsed_geometries.

Revision ID: 0002_parse_options
Revises: 0001_initial
Create Date: 2026-05-01 19:30:00.000000

The column captures per-job knobs (currently ``pageNumber`` for PDFs)
that participate in the idempotency key. Persisting it makes audits
reproducible and allows the worker to re-derive the exact options used
on a given run.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002_parse_options"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "parsed_geometries",
        sa.Column(
            "parse_options",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("parsed_geometries", "parse_options")
