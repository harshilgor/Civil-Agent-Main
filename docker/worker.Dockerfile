FROM python:3.11-slim-bookworm AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libgl1 \
        libglib2.0-0 \
        poppler-utils \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY apps /app/apps
COPY packages /app/packages
COPY pyproject.toml /app/pyproject.toml

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin civilagent \
    && chown -R civilagent:civilagent /app
USER civilagent

CMD ["arq", "apps.worker.worker.WorkerSettings"]
