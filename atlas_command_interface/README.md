# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console hosted as a static Cloudflare Pages app. The browser app is the single workspace at `/map` for inspecting assets, tracks, and geofeatures, editing geofeature geometry, and commanding assets.

This project is greenfield: remove stale helpers and reshape contracts instead of preserving backwards compatibility.

## What Lives Here

- `src/auth/ui/` - the React login gate. It talks to Atlas Core `/admin/auth/*` through the SDK admin client.
- `src/atlas/` - operational Atlas helpers for entities, tasks, objects, queries, sync, feed, geometry, command catalog parsing, and command targeting.
- `src/ui/` - the local design system.
- `src/features/` - feature screens and panels.
- `src/app/` - config loading, providers, routing, and the Vite entry point.
- `public/maps/styles/` - static MapLibre styles for public basemap sources.

The browser calls Atlas Core directly through the SDK with `credentials: "include"`. Local Vite dev defaults to `http://127.0.0.1:8000`; production and preview builds default to the live tunnel hostname `https://atlascommandapi.org`. Set `VITE_ATLAS_CORE_BASE_URL` when a build needs a different Core URL. Login state is a Core-owned `atlas_session` cookie with `HttpOnly; Secure`.

## Boundary

- `AtlasClient` is resource-only: entities, tasks, objects, queries, sync, and feed.
- `AtlasAdminClient` is admin-only: `auth.login`, `auth.logout`, `auth.me`, and managed API key administration.
- Admin records never enter the SDK resource cache or full dataset/changed-since responses.
- The command interface does not own Core auth/session routes, `/atlas/*` proxy routes, feed bridging, API-key injection, or command validation.
- Browser config is build/dev-time Vite config, not a runtime Worker route.

The committed browser config contains only non-secret values: Core base URL defaults, protocol revision, the default map source ID, and public MapLibre style URLs.

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

2. Run the Vite app:

   ```bash
   npm --prefix atlas_command_interface run dev
   ```

Open http://127.0.0.1:5173/map and sign in with `admin` / `password`.

If you need a different Core URL:

```bash
VITE_ATLAS_CORE_BASE_URL=https://api.example.test npm --prefix atlas_command_interface run dev
```

The default admin password is development-only. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` before exposing Core outside local development.

## Map Sources

The browser receives static style URLs such as `/maps/styles/esri-world-imagery.json`. Vite and Cloudflare Pages serve those files from `public/maps/styles/`, and MapLibre requests public provider tiles directly from the style definitions.

Curated sources:

- `esri-world-imagery` - public ArcGIS World Imagery.
- `usgs-topo` - public USGS Topo.

Secret-backed providers such as MapTiler or Mapbox are intentionally out of scope for the static Pages app until there is a real requirement for an authenticated tile service.

## Cloudflare Pages

Use these settings for the Pages project:

- Project name: `atlas`
- Production branch: `main`
- Root directory: `atlas_command_interface`
- Build command: `npm run build`
- Build output directory: `dist/client`

The Core API is exposed through Cloudflare Tunnel at `https://atlascommandapi.org`. A same-site browser alias, `https://api.atlasinterface.com`, can point to the same tunnel service once its Cloudflare DNS record exists; use `VITE_ATLAS_CORE_BASE_URL=https://api.atlasinterface.com` to switch Pages builds to that alias. Core must allow `https://atlasinterface.com` plus the trusted Pages preview pattern in `CORS_ORIGIN_PATTERNS`.

## Checks

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
```
