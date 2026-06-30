# Atlas Simulations

Local workbench for running trusted Atlas simulation scenarios against Atlas Core through the Atlas SDK.

## Configuration

Copy `.env.example` to `.env` and set the local Core connection values:

```text
ATLAS_BASE_URL=http://localhost:8000
ATLAS_API_KEY=replace-with-local-core-key
ATLAS_SIM_PORT=5180
```

Keep normal simulation work pointed at a local Atlas Core (`ATLAS_BASE_URL=http://localhost:8000`). The config also accepts HTTPS Atlas Core targets, including `ATLAS_BASE_URL=https://atlascommandapi.org`, for isolated, disposable tenants because run state is local to this workbench and cleanup can only remove resources while the run remains in memory. If the workbench restarts before cleanup, remote resources from that run may be left behind. Plain HTTP is only accepted for loopback development URLs. The workbench server itself is still served on loopback only; that browser-facing guard is separate from the Atlas Core `ATLAS_BASE_URL`.

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
