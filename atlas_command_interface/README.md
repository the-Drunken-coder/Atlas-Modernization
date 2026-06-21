# Atlas Command Interface

Atlas Command Interface is an operator-facing tactical map console plus the
Cloudflare Worker that gateways it to Atlas Core. The browser app is the single
workspace at `/map`: a dark, dense, map-first console for inspecting assets,
tracks, and geofeatures, editing geofeature geometry, and commanding assets.

This project is greenfield: remove stale helpers and reshape contracts instead
of preserving backwards compatibility.

## What Lives Here

- `worker/` — the Cloudflare Worker / API gateway. Same-origin routes:
  - `/atlas/*` proxies Atlas Core HTTP requests.
  - `/atlas/feed` bridges browser WebSockets to the Core change feed.
  - `/api/config` returns non-secret browser/runtime config (`atlasBaseUrl`,
    `protocolRevision`, optional `mapStyleUrl`).
  - `/api/commands` validates command submissions and creates Atlas tasks.
  - Everything else serves the built single-page app (`dist/client`) with
    SPA fallback, so `/home` and `/map` resolve to the React app.
- `src/atlas/` — reusable Atlas data/command helpers (catalog parsing, command
  targeting, geometry editing, entity/task accessors, the snapshot store, and
  the SDK-backed data source). Framework-agnostic and unit-tested.
- `src/ui/` — the local design system: semantic tokens (`tokens.css`),
  primitives, layout (rail/panel/shell), and the MapLibre view.
- `src/features/` — feature screens: entity lists, asset/track/geofeature
  inspectors, the command list/form, and the `MapConsole` page that wires it all.
- `src/app/` — config loading, providers, routing, and the Vite entry point.

The browser reaches Atlas Core only through the same-origin Worker; it never
learns private Core deployment details. Live updates flow over `/atlas/feed`
with refresh/recovery through normal Core queries (both via the Atlas SDK).

## Local Development

1. Start Atlas Core from this checkout.
2. Seed the command catalog with `python3 Atlas_Core/scripts/seed_command_catalog.py --api-url http://localhost:8000`.
3. Configure non-secret Worker vars in `wrangler.jsonc`. To override the default
   dark basemap, set a `MAP_STYLE_URL` var to a MapLibre style URL.
4. Add `.dev.vars` for local secrets. `ATLAS_COMMAND_API_KEY` gates `/api/commands`; `ATLAS_API_KEY` is only for Worker-to-Core requests when Core auth is enabled:

   ```text
   ATLAS_COMMAND_API_KEY=replace-with-local-command-key
   ATLAS_API_KEY=replace-with-local-core-key
   ```

5. Regenerate Worker bindings after config changes:

   ```bash
   npm --prefix atlas_command_interface run cf:types
   ```

6. Run the Worker (serves `/api` + `/atlas`) and the Vite dev server together:

   ```bash
   npm --prefix atlas_command_interface run dev:worker   # wrangler dev on :8787
   npm --prefix atlas_command_interface run dev           # vite on :5173, proxies /api + /atlas
   ```

   Open http://localhost:5173/map. The browser holds the command API key in
   `localStorage` (entered through the command form); it is never embedded at
   build time. Command submissions send `Authorization: Bearer <ATLAS_COMMAND_API_KEY>`.

No deployment, routes, custom domains, or production secrets are configured here.

## Storybook UI Workbench

Storybook is the dev-only catalog for the shared operator UI system. It renders
fixture-backed states for primitives, the rail/sidebar shell, entity lists,
inspectors, command forms, MapLibre map views, and the full `/map` console
without requiring a live Atlas Core.

```bash
npm --prefix atlas_command_interface run storybook
npm --prefix atlas_command_interface run build-storybook
```

Keep stories focused on reusable UI states and operational fixtures. The live
`/map` page remains the integration surface for Core, Worker, and map behavior.

## Checks

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run typecheck
npm --prefix atlas_command_interface run build
npm --prefix atlas_command_interface run build-storybook
```
