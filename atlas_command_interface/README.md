# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console hosted by a thin Cloudflare Worker. The browser app is the single workspace at `/map` for inspecting assets, tracks, and geofeatures, editing geofeature geometry, and commanding assets.

This project is greenfield: remove stale helpers and reshape contracts instead of preserving backwards compatibility.

## What Lives Here

- `worker/` - static asset hosting plus `GET /api/config`.
- `src/auth/ui/` - the React login gate. It talks to Atlas Core `/admin/auth/*` through the SDK admin client.
- `src/atlas/` - operational Atlas helpers for entities, tasks, objects, queries, sync, feed, geometry, command catalog parsing, and command targeting.
- `src/ui/` - the local design system.
- `src/features/` - feature screens and panels.
- `src/app/` - config loading, providers, routing, and the Vite entry point.

The browser calls Atlas Core directly. It does not receive a durable Core API key. Login state is a Core-owned `atlas_session` cookie with `HttpOnly; Secure`; Core requests use `credentials: "include"`.

## Boundary

- `AtlasClient` is resource-only: entities, tasks, objects, queries, sync, and feed.
- `AtlasAdminClient` is admin-only: `auth.login`, `auth.logout`, and `auth.me`.
- Admin records never enter the SDK resource cache or full dataset/changed-since responses.
- The Worker does not own `/auth/*`, `/me/settings`, `/atlas/*`, feed bridging, API-key injection, or command validation.

`/api/config` returns only non-secret browser config: Core base URL, protocol revision, and optional MapLibre style URL.

## Commands

Command availability fails closed. An asset can receive a command only when its `components.task_catalog.supported_tasks` array explicitly lists that command ID.

Command submission posts a task directly to Core without a client-supplied `task_id`. Core validates the command catalog, target entity support, and parameters, then generates a `command-<uuid>` task ID. Non-command task creation keeps the normal Atlas Core task contract.

## Local Development

1. Start Atlas Core from this checkout. Startup seeds the development admin account `admin` / `password`.
2. Seed the command catalog with `python3 Atlas_Core/scripts/seed_command_catalog.py --api-url http://localhost:8000`.
3. Configure the Worker with `ATLAS_CORE_BASE_URL`; optional `MAP_STYLE_URL` overrides the default OpenStreetMap basemap.
4. Run the Worker and Vite dev server:

   ```bash
   npm --prefix atlas_command_interface run dev:worker
   npm --prefix atlas_command_interface run dev
   ```

Open http://localhost:5173/map and sign in with `admin` / `password`.

The default admin password is development-only. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` before exposing Core outside local development.

## Checks

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
```
