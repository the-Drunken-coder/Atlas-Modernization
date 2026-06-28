# Atlas Simulations

Local workbench for running trusted Atlas simulation scenarios against Atlas Core through the Atlas SDK.

## Configuration

Copy `.env.example` to `.env` and set the local Core connection values:

```text
ATLAS_BASE_URL=http://localhost:8000
ATLAS_API_KEY=replace-with-local-core-key
ATLAS_SIM_PORT=5180
```

Keep normal simulation work pointed at a local Atlas Core (`ATLAS_BASE_URL=http://localhost:8000`). Hosted targets such as `ATLAS_BASE_URL=https://atlascommandapi.org` are only for isolated, disposable tenants because run state is local to this workbench and cleanup can only remove resources while the run remains in memory. If you intentionally target the hosted API, set `ATLAS_API_KEY` to a key issued for that tenant and do not reuse a local-only Core key there.

The API key is read only by the local Node server. Browser code calls same-origin simulation routes and never receives the key.

## Development

Start the local API server:

```bash
npm --prefix atlas_simulations run dev:server
```

Start the browser UI:

```bash
npm --prefix atlas_simulations run dev
```

Open http://127.0.0.1:5174.

## Checks

```bash
npm --prefix atlas_simulations test
npm --prefix atlas_simulations run typecheck
npm --prefix atlas_simulations run build
```
