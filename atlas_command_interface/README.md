# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console plus the
Cloudflare Worker that gateways it to Atlas Core. The browser app currently
runs at `/map` as a read-only workspace for inspecting assets, tracks, and
geofeatures.

This project is greenfield: remove stale helpers and reshape contracts instead
of preserving backwards compatibility.

## What Lives Here

- `worker/` - the Cloudflare Worker / API gateway. Same-origin routes:
  - `/atlas/*` proxies Atlas Core HTTP requests.
  - `/atlas/feed` bridges browser WebSockets to the Core change feed.
  - `/api/config` returns non-secret browser/runtime config (`atlasBaseUrl`,
    `protocolRevision`, optional `mapStyleUrl`).
  - `/api/commands` validates command submissions and creates Atlas tasks.
  - Everything else serves the built single-page app (`dist/client`) with
    SPA fallback, so `/home` and `/map` resolve to the React app.
- `src/atlas/` - reusable Atlas data helpers: catalog parsing, command
  targeting contracts, geometry normalisation, entity/task accessors, the
  snapshot store, and the SDK-backed data source.
- `src/ui/` - the local design system: semantic tokens, primitives, layout
  components, and the MapLibre view.
- `src/features/` - read-only feature screens: entity lists, asset/track/
  geofeature inspectors, and the `MapConsole` page that wires them together.
- `src/app/` - config loading, providers, routing, and the Vite entry point.

The browser reaches Atlas Core only through the same-origin Worker; it never
learns private Core deployment details. Live updates flow over `/atlas/feed`
with refresh/recovery through normal Core queries, both via the Atlas SDK.
The map workspace requires MapLibre/WebGL; unsupported environments show a
clear map-unavailable state.

## Command Support Policy

Command availability fails closed. An asset can receive a command only when its
`components.task_catalog.supported_tasks` array explicitly lists that command ID.
Assets with a missing or malformed task catalog have no available commands. The
Worker enforces this before creating a task; browser command controls are added
in the follow-up command/editing branch.

## Local Development

1. Start Atlas Core from this checkout.
2. Seed the command catalog with `python3 Atlas_Core/scripts/seed_command_catalog.py --api-url http://localhost:8000`.
3. Configure non-secret Worker vars in `wrangler.jsonc`. To override the default
   dark basemap, set a `MAP_STYLE_URL` var to a MapLibre style URL.
4. Add `.dev.vars` for local secrets:

   ```text
   ATLAS_COMMAND_API_KEY=replace-with-local-command-key
   ATLAS_API_KEY=replace-with-local-core-key
   ```

5. Regenerate Worker bindings after config changes:

   ```bash
   npm --prefix atlas_command_interface run cf:types
   ```

6. Run the Worker and Vite dev server in separate terminals:

   ```bash
   # terminal 1
   npm --prefix atlas_command_interface run dev:worker

   # terminal 2
   npm --prefix atlas_command_interface run dev
   ```

   Open http://localhost:5173/map.

No deployment, routes, custom domains, or production secrets are configured here.

## Checks

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
```
