# Atlas Simulations

Local workbench for running trusted Atlas simulation scenarios against Atlas Core through the Atlas SDK.

## Configuration

Copy `.env.example` to `.env` and set the Core connection values:

```text
ATLAS_BASE_URL=http://localhost:8000
ATLAS_API_KEY=replace-with-local-core-key
ATLAS_LOCAL_BASE_URL=http://localhost:8000
ATLAS_LOCAL_API_KEY=replace-with-local-core-key
ATLAS_DEPLOYED_BASE_URL=https://atlascommandapi.org
ATLAS_DEPLOYED_API_KEY=replace-with-deployed-core-key
ATLAS_SIM_TARGET=local
ATLAS_SIM_PORT=5180
```

The top API menu exposes a local target and a deployed target. `ATLAS_BASE_URL` and `ATLAS_API_KEY` still work as the legacy/default connection and decide the initial menu selection unless `ATLAS_SIM_TARGET` is set. Use `ATLAS_LOCAL_*` and `ATLAS_DEPLOYED_*` when the two targets need different URLs or API keys.

You can also paste an API key into the topbar while the workbench is running. That key is kept in browser memory and sent only to the local simulation server for the selected target; it is not written to `.env` or returned in run summaries.

Keep normal simulation work pointed at a local Atlas Core (`ATLAS_LOCAL_BASE_URL=http://localhost:8000`). The deployed target accepts HTTPS Atlas Core targets, including `ATLAS_DEPLOYED_BASE_URL=https://atlascommandapi.org`, for isolated, disposable tenants because run state is local to this workbench and cleanup can only remove resources while the run remains in memory. If the workbench restarts before cleanup, remote resources from that run may be left behind. Plain HTTP is only accepted for loopback development URLs. The workbench server itself is still served on loopback only; that browser-facing guard is separate from the selected Atlas Core target.

The API key is read only by the local Node server. Browser code calls same-origin simulation routes and never receives the key.

## Development

Use Node 24 LTS from the repository root `.nvmrc` before installing dependencies.

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
npm --prefix atlas_simulations run lint
npm --prefix atlas_simulations run format:check -- --since=origin/main
npm --prefix atlas_simulations test
npm --prefix atlas_simulations run typecheck
npm --prefix atlas_simulations run build
```
