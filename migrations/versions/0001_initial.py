"""Initial schema for organizations / projects / files / parsed geometries.

Revision ID: 0001_initial
Revises:
Create Date: 2026-05-01 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "org_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_projects_org", "projects", ["org_id"])

    op.create_table(
        "project_files",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("original_filename", sa.Text, nullable=False),
        sa.Column("file_format", sa.String(8), nullable=False),
        sa.Column("s3_key", sa.Text, nullable=False),
        sa.Column("content_type", sa.String(255), nullable=True),
        sa.Column("file_size_bytes", sa.BigInteger, nullable=True),
        sa.Column("file_sha256", sa.String(64), nullable=True),
        sa.Column(
            "uploaded_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_files_project", "project_files", ["project_id"])
    op.create_index("ix_files_hash", "project_files", ["file_sha256"])

    op.create_table(
        "parsed_geometries",
        sa.Column("id", postgresql.UUID(as_uuid=False), primary_key=True),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_file_id",
            postgresql.UUID(as_uuid=False),
            sa.ForeignKey("project_files.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("parse_status", sa.String(16), nullable=False, server_default="processing"),
        sa.Column("review_status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("geometry_data", postgresql.JSONB, nullable=False, server_default="{}"),
        sa.Column("overall_confidence", sa.Float, nullable=True),
        sa.Column("warnings", postgresql.ARRAY(sa.Text), nullable=True),
        sa.Column("parser_version", sa.String(32), nullable=False),
        sa.Column("schema_version", sa.String(64), nullable=False),
        sa.Column("run_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("job_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column("idempotency_key", sa.String(64), nullable=True),
        sa.Column("failed_step", sa.String(32), nullable=True),
        sa.Column("failed_step_code", sa.String(64), nullable=True),
        sa.Column("duration_ms", sa.Integer, nullable=True),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("completed_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("accepted_at", sa.TIMESTAMP(timezone=True), nullable=True),
        sa.Column("accepted_by", postgresql.UUID(as_uuid=False), nullable=True),
        sa.UniqueConstraint(
            "project_id", "idempotency_key", name="uq_parsed_idempotency"
        ),
    )
    op.create_index(
        "ix_parsed_project_status", "parsed_geometries", ["project_id", "parse_status"]
    )
    op.create_index(
        "ix_parsed_project_review", "parsed_geometries", ["project_id", "review_status"]
    )


def downgrade() -> None:
    op.drop_index("ix_parsed_project_review", table_name="parsed_geometries")
    op.drop_index("ix_parsed_project_status", table_name="parsed_geometries")
    op.drop_table("parsed_geometries")
    op.drop_index("ix_files_hash", table_name="project_files")
    op.drop_index("ix_files_project", table_name="project_files")
    op.drop_table("project_files")
    op.drop_index("ix_projects_org", table_name="projects")
    op.drop_table("projects")
    op.drop_table("organizations")
