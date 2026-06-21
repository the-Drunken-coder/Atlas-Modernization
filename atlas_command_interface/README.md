# Atlas Command Interface

Atlas Command Interface is currently the Worker/API and reusable function layer for future Atlas command surfaces. It intentionally does not contain a React app, MapLibre view, routes, components, or a command drawer yet.

This project is greenfield: remove stale helpers and reshape contracts instead of preserving backwards compatibility.

## What Lives Here

- `worker/index.ts` implements same-origin Worker routes:
  - `/atlas/*` proxies Atlas Core HTTP requests.
  - `/atlas/feed` bridges browser WebSockets to the Core feed.
  - `/api/config` returns non-secret browser/runtime config.
  - `/api/commands` validates command submissions and creates Atlas tasks.
- `src/atlas/command-model.ts` parses command catalogs, filters supported commands, validates parameters, and builds task payloads.
- `src/atlas/api.ts` contains small client-side API helpers for future UI surfaces.
- `src/atlas/selectors.ts` contains entity/task/object selectors and map-feature projection helpers.
- `src/index.ts` re-exports the reusable function surface.

## Local Development

1. Start Atlas Core from this checkout.
2. Seed the command catalog with `python3 Atlas_Core/scripts/seed_command_catalog.py --api-url http://localhost:8000`.
3. Configure non-secret Worker vars in `wrangler.jsonc`.
4. Add `.dev.vars` for local secrets. `ATLAS_COMMAND_API_KEY` gates `/api/commands`; `ATLAS_API_KEY` is only for Worker-to-Core requests when Core auth is enabled:

   ```text
   ATLAS_COMMAND_API_KEY=replace-with-local-command-key
   ATLAS_API_KEY=replace-with-local-core-key
   ```

5. Regenerate Worker bindings after config changes:

   ```bash
   npm --prefix atlas_command_interface run cf:types
   ```

6. Run the Worker locally:

   ```bash
   npm --prefix atlas_command_interface run dev -- --port 5173
   ```

No deployment, routes, custom domains, or production secrets are configured here.

Command submissions must send either `Authorization: Bearer <ATLAS_COMMAND_API_KEY>` or `X-API-Key: <ATLAS_COMMAND_API_KEY>`.

## Checks

```bash
npm --prefix atlas_command_interface test
npm --prefix atlas_command_interface run cf:types
npm --prefix atlas_command_interface run build
```
