# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console hosted as a static Cloudflare Pages app. The browser app is the single workspace at `/map` for inspecting assets, tracks, and geofeatures, editing geofeature geometry, and commanding assets.

This project is greenfield: remove stale helpers and reshape contracts instead of preserving backwards compatibility.

## What Lives Here

- `src/auth/ui/` - the React login gate. It talks to Atlas Core `/admin/auth/*` through the SDK admin client.
- `src/atlas/` - operational Atlas helpers for entities, tasks, objects, queries, sync, feed, geometry, command catalog parsing, and command targeting.
- `src/ui/` - the local design system.
- `src/features/` - feature screens and panels.
- `src/app/` - config loading, providers, routing, and the Vite entry point.

The browser calls Atlas Core directly through the SDK with `credentials: "include"`. Local Vite dev defaults to `http://127.0.0.1:8000`; production and preview builds default to the same-site tunnel alias `https://api.atlasinterface.com`. Set `VITE_ATLAS_CORE_BASE_URL` when a build needs a different Core URL. Login state is a Core-owned `atlas_session` cookie with `HttpOnly; Secure`.

## Boundary

- `AtlasClient` is resource-only: entities, tasks, objects, queries, sync, and feed.
- `AtlasAdminClient` is admin-only: `auth.login`, `auth.logout`, `auth.me`, and managed API key administration.
- Admin records never enter the SDK resource cache or full dataset/changed-since responses.
- The command interface does not own Core auth/session routes, `/atlas/*` proxy routes, feed bridging, API-key injection, or authoritative command validation. It still performs non-authoritative UI coercion and availability checks before submitting command tasks to Core.
- Browser config is build/dev-time Vite config, not a runtime Worker route.

The committed browser config contains only non-secret values: Core base URL defaults, protocol revision, map source IDs, labels, and provider URL templates. Any `VITE_*` provider keys are browser-visible and must be restricted in the provider dashboards.

## Commands

Command availability fails closed. An asset can receive a command only when its `components.task_catalog.supported_tasks` array explicitly lists that command ID.

Command submission posts a task directly to Core without a client-supplied `task_id`. Core validates the command catalog, target entity support, and parameters, then generates a `command-<uuid>` task ID. Non-command task creation keeps the normal Atlas Core task contract.

## Local Development

Use Node 24 LTS from the repository root `.nvmrc` before installing dependencies.

1. Start local Atlas Core from this checkout:

   ```bash
   python3 Atlas_Core/scripts/atlas.py --dev
   ```

   `atlas.py` starts Docker Compose, waits for PostgreSQL, MinIO, and the API, then publishes the embedded command catalog through the object API for browser/reference use. Startup seeds the development admin account `admin` / `password`.
   If an old local Postgres volume has stale credentials, run `python3 Atlas_Core/scripts/atlas.py --dev --reset-volumes`.

2. Run the Vite app:

   ```bash
   npm --prefix atlas_command_interface run dev
   ```

Open http://127.0.0.1:5173/map and sign in with `admin` / `password`.

If you need a different Core URL:

```bash
VITE_ATLAS_CORE_BASE_URL=https://api.example.test npm --prefix atlas_command_interface run dev
```

For local map-provider testing, copy `atlas_command_interface/.env.example` to `atlas_command_interface/.env.local` and fill only the provider keys you want to enable. `.env.local` is ignored by git.

The default admin password is development-only. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` before exposing Core outside local development.

## Map Sources

The browser builds MapLibre raster styles from provider tile URL templates. Public sources are selectable by default; credentialed sources stay visible in the map selector and are disabled until their matching `VITE_*` env var is available at build/dev time. Google Satellite also requires a successful tile-session request; with a key but no session it remains visible as unavailable.

Always available:

- `openstreetmap-default` - OpenStreetMap Standard raster tiles.
- `usgs-topo` - public USGS Topo.
- `openmaptiles-dark-matter` - CARTO-hosted Dark Matter raster tiles based on OpenStreetMap/OpenMapTiles styling.

Credentialed sources:

- `google-satellite` - set `VITE_GOOGLE_MAPS_API_KEY`. The app creates the required Google Maps Tile API satellite session at startup.
- `mapbox-satellite`, `mapbox-outdoors`, `mapbox-dark` - set `VITE_MAPBOX_ACCESS_TOKEN`.
- `thunderforest-outdoors` - set `VITE_THUNDERFOREST_API_KEY`.
- `maptiler-satellite`, `maptiler-osm-dark` - set `VITE_MAPTILER_API_KEY`.

Microsoft imagery via Bing or Azure Maps is intentionally deferred for the static app because it needs supported tile metadata, required attribution handling, and safer token/key handling.

## Cloudflare Pages

Use these settings for the Pages project:

- Project name: `atlas`
- Production branch: `main`
- Root directory: `atlas_command_interface`
- Node version: `24` (from `.nvmrc`)
- Build command: `npm run build`
- Build output directory: `dist/client`

The Core API is exposed through Cloudflare Tunnel at `https://atlascommandapi.org`, with `https://api.atlasinterface.com` as the browser-facing alias for the same tunnel service. Core must allow `https://atlasinterface.com` plus the trusted Pages preview pattern in `CORS_ORIGIN_PATTERNS`.

## Checks

```bash
npm --prefix atlas_command_interface run lint
npm --prefix atlas_command_interface run format:check -- --since=origin/main
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
```
