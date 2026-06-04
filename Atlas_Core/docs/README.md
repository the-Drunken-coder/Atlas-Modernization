# Documentation Index

_Revision: 2026-05-29_

## Overview

This directory contains operational docs for the Go-based Atlas Core service.

## Navigation

| Topic | File | Description |
| --- | --- | --- |
| Entity Status | `ASSET_STATUS_SYSTEM.md` | Entity types, status tracking, and telemetry updates. |
| Pagination | `PAGINATION.md` | `limit`/`cursor` behavior and pagination headers. |
| Database Workflow | `DATABASE_WORKFLOW.md` | Schema bootstrap model and developer workflow. |
| Entities | `database-structure/entities.md` | Entity JSON blob structure and component guidance. |
| Tasks | `database-structure/tasks.md` | Task blob schema and lifecycle endpoint notes. |
| Objects | `database-structure/objects.md` | Object metadata schema and storage endpoint notes. |
| Examples | `database-structure/examples/` | JSON examples for entities, tasks, and objects. |
| Errors | `ERROR_HANDLING.md` | Error taxonomy and HTTP envelope mapping. |
| Security | `SECURITY.md` | CORS/API key auth behavior and hardening checklist. |

## Heatmap Media Conventions

- Geometry belongs on the geofeature entity (`components.geometry`).
- Heatmap media objects should use:
  - `type = "heatmap"`
  - `usage_hints` including `"heatmap_data"`
  - `content_type` appropriate to payload (`application/json` or `image/png`)
- Link object-to-entity via object metadata `referenced_by` (`POST /objects` or `PATCH /objects/{object_id}`).
- Link entity-to-object via `components.media_refs` with role `"heatmap_data"`.

Current implementation note: heatmap object fields (`type`, `usage_hints`, `content_type`) are convention-based. On entities, `media_refs[].role` **is** validated and must be one of `camera_feed`, `thumbnail`, or `heatmap_data` when present. The server does not enforce one-active-heatmap-per-role or reject geometry-like keys in object payloads.

## Maintenance Process

1. Author updates the relevant document with code-backed behavior.
2. Peer review verifies claims against `internal/` implementation.
3. API-affecting changes should be reflected in docs in the same PR.

## Review Cadence

- Weekly triage for open doc drift.
- Quarterly implementation-vs-doc audit.
- Incident follow-up: update docs when behavior changes.
