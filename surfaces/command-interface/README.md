# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console hosted as a static Cloudflare Pages app. The browser app is the single workspace at `/map` for inspecting assets, tracks, and geofeatures, editing geofeature geometry, and commanding assets.

This project is greenfield: remove stale helpers and reshape contracts instead of preserving backwards compatibility.

## What Lives Here

- `src/auth/ui/` - the React login gate. It talks to Atlas Core `/admin/auth/*` through the SDK admin client.
- `src/atlas/` - operational Atlas helpers for entities, tasks, objects, queries, sync, feed, geometry, typed command-catalog consumption, and command targeting.
- `src/ui/` - the local design system.
- `src/features/` - feature screens and panels.
- `src/app/` - config loading, providers, routing, and the Vite entry point.

The browser calls Atlas Core directly through the SDK with `credentials: "include"`. Local Vite dev defaults to `http://127.0.0.1:8000`; production and preview builds default to the same-site tunnel alias `https://api.atlasinterface.com`. Set `VITE_ATLAS_CORE_BASE_URL` when a build needs a different Core URL. Login state is a Core-owned `atlas_session` cookie with `HttpOnly; Secure`.

Anonymous visits load only the public login shell and check `/admin/auth/me`. The map workspace, Atlas data source, and map-provider initialization are loaded after Core confirms the session.

## Boundary

- `AtlasClient` is resource-only: entities, tasks, objects, queries, sync, and feed.
- `AtlasAdminClient` is admin-only: `auth.login`, `auth.logout`, `auth.me`, and managed API key administration.
- Admin records never enter the SDK resource cache or full dataset/changed-since responses.
- The command interface does not own Core auth/session routes, `/atlas/*` proxy routes, feed bridging, API-key injection, or authoritative Command validation. It performs non-authoritative availability and input checks before submitting a Task to Core.
- Browser config is build/dev-time Vite config, not a runtime Worker route.

The committed browser config contains only non-secret values: Core base URL defaults, protocol revision, map source IDs, labels, and provider URL templates. Any `VITE_*` provider keys are browser-visible and must be restricted in the provider dashboards.

## Live Updates and Startup Recovery

The websocket feed is the low-latency update path. The SDK also runs its default two-minute `changed-since` poll as a low-traffic safety net, so the console still converges when a browser, proxy, or tunnel blocks websockets or reconnect recovery is slow. Polling remains a backstop rather than a replacement for the feed.

If the safety-net request fails, the SDK keeps its degraded/read-through behavior: covered point reads go back to Core instead of trusting a cache that may be stale. The command catalog is loaded directly from Core's embedded `/command-catalog` endpoint during setup; failure leaves the command interface unavailable rather than starting with stale command definitions.

Configuration, session-check, and initial SDK connection failures expose one-shot operator retry actions. They do not start an automatic retry loop; each click performs one new attempt, and a failed SDK startup is disposed before the replacement data source starts.

## Commands

Command availability fails closed. A Command appears only when it exists in the Protocol-owned catalog, appears in the selected Asset's read-only current `command_manifest`, and has a purpose-built input registered in the interface.

Command submission posts `{ asset_id, command, input }` directly to Core with a fresh idempotency key for that tasking attempt. Core validates the generated catalog, current ready runtime manifest, and input, then generates the Task ID. The initial generated catalog and interface registry are empty, so the UI intentionally shows that no Commands are defined.

Generic schema-generated forms are not part of the interface. Adding a Command includes its purpose-built operator input, tests, Protocol schema, Asset handler, and any special Core policy through the [Command authoring guide](../../packages/protocol/commands/README.md).

## Local Development

Use Node 24 LTS from the repository root `.nvmrc`.

1. Install the JavaScript workspace from the repository root:

   ```bash
   npm ci
   ```

2. Start local Atlas Core from this checkout:

   ```bash
   python3 services/core/scripts/atlas.py --dev
   ```

   `atlas.py` starts Docker Compose and waits for PostgreSQL, MinIO, and the API. Atlas Core serves the embedded command catalog directly at `/command-catalog`, independent of the object store. Startup seeds the `admin` account with the generated `ATLAS_ADMIN_PASSWORD` stored in the owner-only `services/core/docker/.env.local`.
   If an old local Postgres volume has stale credentials, run `python3 services/core/scripts/atlas.py --dev --reset-volumes`.

3. Build the local SDK package and run the Vite app:

   ```bash
   npm run dev:command-interface
   ```

Open http://127.0.0.1:5173/map and sign in as `admin` with the `ATLAS_ADMIN_PASSWORD` from `services/core/docker/.env.local`.

If you need a different Core URL:

```bash
VITE_ATLAS_CORE_BASE_URL=https://api.example.test npm run dev:command-interface
```

For local map-provider testing, copy `surfaces/command-interface/.env.example` to `surfaces/command-interface/.env.local` and fill only the provider keys you want to enable. `.env.local` is ignored by git.

The generated local admin password is development-only. Set `ATLAS_ADMIN_PASSWORD` or `ATLAS_ADMIN_PASSWORD_FILE` explicitly before exposing Core outside local development.

## Map Sources

The authenticated workspace builds MapLibre raster styles from provider tile URL templates. `maptiler-osm-dark` (`MapTiler OSM Dark`) is the initial default when no explicit operator selection exists. Credentialed sources stay visible in the map selector and are disabled until their matching `VITE_*` env var is available at build/dev time. Google Satellite also requires a successful tile-session request; with a key but no session it remains visible as unavailable. If the configured default is unavailable, the interface uses its existing map-source error state instead of silently selecting another deployed source.

Always available:

- `openstreetmap-default` - OpenStreetMap Standard raster tiles.
- `usgs-topo` - public USGS Topo.
- `openmaptiles-dark-matter` - CARTO-hosted Dark Matter raster tiles based on OpenStreetMap/OpenMapTiles styling.

Credentialed sources:

- `google-satellite` - set `VITE_GOOGLE_MAPS_API_KEY`. The app creates the required Google Maps Tile API satellite session only after authentication.
- `mapbox-satellite`, `mapbox-outdoors`, `mapbox-dark` - set `VITE_MAPBOX_ACCESS_TOKEN`.
- `thunderforest-outdoors` - set `VITE_THUNDERFOREST_API_KEY`.
- `maptiler-satellite`, `maptiler-osm-dark` - set `VITE_MAPTILER_API_KEY`.

Microsoft imagery via Bing or Azure Maps is intentionally deferred for the static app because it needs supported tile metadata and safer token/key handling.

The configured `maptiler-osm-dark` source remains the default whether or not its key is available. A valid explicit operator selection takes precedence; `openstreetmap-default` remains selectable but is not an automatic fallback when the configured default is unavailable.

## Place Search

The Places rail workspace uses MapTiler's browser geocoding API. `VITE_MAPTILER_API_KEY` enables both MapTiler basemaps and place search; without it, the workspace stays visible and explains why search is unavailable. Restrict the browser-visible key to the deployed Atlas origins in MapTiler.

Search starts after two characters and returns at most five results. Hovering or focusing a result keeps the main camera fixed and opens a noninteractive local detail map. Clicking the result or pressing Enter or Space flashes the reticle, closes the detail map, and commits a tighter main-map view. Escape returns focus to the search field. The **World view** action returns the camera to the default overview without clearing the query. Atlas aborts stale autocomplete requests and does not persist search results.

## Cloudflare Pages

Use these settings for the Pages project:

- Project name: `atlas`
- Production branch: `main`
- Root directory: `/`
- Build command: `npm run build:command-interface`
- Build output directory: `surfaces/command-interface/dist/client`
 - Node version: `24` (committed in the root `.nvmrc`)

The repository root must remain the Pages root so dependency installation uses the workspace lockfile and links the local SDK package. For a manual Wrangler deploy from the repository root, run `npm run deploy:command-interface`.

The Core API is exposed through Cloudflare Tunnel at `https://atlascommandapi.org`, with `https://api.atlasinterface.com` as the browser-facing alias for the same tunnel service. Core must allow `https://atlasinterface.com` plus the trusted Pages preview pattern in `CORS_ORIGIN_PATTERNS`.

The production build emits `dist/client/_headers` with the static Pages security policy, including frame denial and the exact Core, WebSocket, and supported tile-provider origins. `VITE_ATLAS_CORE_BASE_URL` selects both the app's Core URL and the matching HTTPS/WSS `connect-src` entries; no separate header edit is required.

## Checks

```bash
npm run build:sdk
npm run lint --workspace @the-drunken-coder/atlas-command-interface
npm run format:check --workspace @the-drunken-coder/atlas-command-interface
npm test --workspace @the-drunken-coder/atlas-command-interface
npm run typecheck --workspace @the-drunken-coder/atlas-command-interface
npm run build:command-interface
```
