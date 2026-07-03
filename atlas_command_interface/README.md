# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console hosted by a thin Cloudflare Worker. The browser app is the single workspace at `/map` for inspecting assets, tracks, and geofeatures, editing geofeature geometry, and commanding assets.

This project is greenfield: remove stale helpers and reshape contracts instead of preserving backwards compatibility.

## What Lives Here

- `worker/` - static asset hosting, `GET /api/config`, `GET /api/auth/me`, the same-origin `/atlas/*` Core proxy, and the same-origin map style/tile gateway.
- `src/auth/ui/` - the React login gate. It talks to Atlas Core `/admin/auth/*` through the SDK admin client.
- `src/atlas/` - operational Atlas helpers for entities, tasks, objects, queries, sync, feed, geometry, command catalog parsing, and command targeting.
- `src/ui/` - the local design system.
- `src/features/` - feature screens and panels.
- `src/app/` - config loading, providers, routing, and the Vite entry point.

The browser calls the command-interface Worker on the same origin. The Worker proxies `/atlas/*` to Atlas Core using `ATLAS_CORE_BASE_URL`, so local and deployed browser traffic use the same URL shape. The browser does not receive a durable Core API key. Login state is a Core-owned `atlas_session` cookie with `HttpOnly; Secure`; Core requests use `credentials: "include"`.

## Boundary

- `AtlasClient` is resource-only: entities, tasks, objects, queries, sync, and feed.
- `AtlasAdminClient` is admin-only: `auth.login`, `auth.logout`, `auth.me`, and managed API key administration.
- Admin records never enter the SDK resource cache or full dataset/changed-since responses.
- The Worker owns `/api/config`, `/api/auth/me`, the `/atlas/*` same-origin Core proxy, and public `/maps/*` map gateway routes.
- The Worker does not own `/auth/*`, `/admin/api-keys/*`, `/me/settings`, feed bridging, API-key injection, or command validation.

`/api/config` returns only non-secret browser config: Core base URL, protocol revision, the default map source ID, and available same-origin MapLibre style URLs. Public map sources are exposed through the Worker. Secret-backed providers stay staged in the source registry until the command interface has an Atlas-owned auth boundary for map routes.

## Commands

Command availability fails closed. An asset can receive a command only when its `components.task_catalog.supported_tasks` array explicitly lists that command ID.

Command submission posts a task directly to Core without a client-supplied `task_id`. Core validates the command catalog, target entity support, and parameters, then generates a `command-<uuid>` task ID. Non-command task creation keeps the normal Atlas Core task contract.

## Local Development

1. Start local Atlas Core from this checkout:

   ```bash
   python3 Atlas_Core/scripts/atlas.py --dev
   ```

   `atlas.py` starts Docker Compose, waits for PostgreSQL, MinIO, and the API, then seeds the command catalog. Startup seeds the development admin account `admin` / `password`.
   If an old local Postgres volume has stale credentials, run `python3 Atlas_Core/scripts/atlas.py --dev --reset-volumes`.

2. Configure local Worker variables:

   ```bash
   cp atlas_command_interface/.dev.vars.example atlas_command_interface/.dev.vars
   ```

   The local default points the Worker at `http://127.0.0.1:8000`. Public map sources work without provider secrets.
   Do not commit `.dev.vars*` files.

3. Run the Worker-hosted web app:

   ```bash
   npm --prefix atlas_command_interface run dev:local
   ```

Open http://127.0.0.1:8787/map and sign in with `admin` / `password`.

The default admin password is development-only. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` before exposing Core outside local development.

## Map Sources

The browser receives same-origin style URLs such as `/maps/styles/esri-world-imagery.json`. MapLibre then requests same-origin tiles through `/maps/tiles/{source}/{z}/{x}/{y}.{ext}`. Public sources are available by default. Secret-backed providers are intentionally not exposed by browser routes yet, even when Cloudflare secrets exist, because the Worker does not own the Core login session.

Curated sources:

- `esri-world-imagery` - public ArcGIS World Imagery.
- `usgs-topo` - public USGS Topo.

Staged provider sources:

- `maptiler-osm-dark` - requires a future authenticated map route before use.
- `maptiler-satellite` - requires a future authenticated map route before use.
- `mapbox-satellite` - requires a future authenticated map route before use.

## Checks

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
```
