# Atlas Simulations

Local workbench for running trusted Atlas simulation scenarios against Atlas Core through the Atlas SDK.

## Configuration

Start the default local Core from the repository root:

```bash
python3 atlas_core/scripts/atlas.py --dev
```

The launcher enables API-key authentication, generates or reuses one local
machine key, and stores it in the owner-only `atlas_core/docker/.env.local`. The
simulations server reads that same key directly for its loopback target. The
key is never sent to the browser or copied into a cleanup ledger.

No simulations `.env` is required for the default loopback workbench. Copy
`.env.example` to `.env` only to override the local URL, port, or target. Set
`ATLAS_LOCAL_API_KEY` only when using a custom loopback Core that was not
started by `atlas.py --dev`.

The workbench exposes only the loopback target by default. To make a deployed Core available, explicitly add all of the following to `.env`:

```text
ATLAS_SIM_ENABLE_DEPLOYED=true
ATLAS_DEPLOYED_BASE_URL=https://api.atlasinterface.com
ATLAS_DEPLOYED_API_KEY=replace-with-deployed-core-key
```

`ATLAS_DEPLOYED_BASE_URL` is required and must be a non-loopback HTTPS URL. A deployed target is never inferred from `ATLAS_BASE_URL`, and the local target remains selected unless `ATLAS_SIM_TARGET=deployed` is also set. The UI displays a danger state for every non-loopback target and requires a fresh confirmation before each run starts. The server enforces that confirmation independently.

You can also paste an API key into the topbar while the workbench is running. That key is kept in browser memory and sent only to the local simulation server for the selected target; it is not written to `.env`, the cleanup ledger, or run summaries. After a restart, paste the key again before cleaning up a recovered run if no deployed key is configured in `.env`.

Keep normal simulation work pointed at a local Atlas Core (`ATLAS_LOCAL_BASE_URL=http://localhost:8000`). Deployed runs are intended only for isolated, disposable tenants. Their run identity, exact target URL, and run-owned cleanup candidates are recorded in one file per run under `.atlas-simulations/runs/` before mutation. The ledger directory is owner-only (`0700`) and each run file is owner-readable/writable only (`0600`). On restart, outstanding runs appear as `abandoned`; the workbench never resumes or cleans them automatically. Review them and use the explicit Cleanup action. Plain HTTP is accepted only for loopback Core URLs. The workbench server itself remains bound to `127.0.0.1`.

Deployed scenarios must provide explicit run-owned task IDs. Core-generated `command-*` task IDs remain available to local scenarios only because their IDs are not known early enough to record safely before a remote mutation.

Configured API keys, including the launcher-generated local key, are read-only server configuration that only the local Node server reads. Browser code calls same-origin simulation routes and never receives configured keys; a key pasted into the UI necessarily remains in that browser tab's memory.

## Development

Use Node 24 LTS from the repository root `.nvmrc`, then install the JavaScript workspace once from the repository root:

```bash
npm ci
```

Start the local API server (building the local SDK package first):

```bash
npm run dev:simulations-server
```

Start the browser UI:

```bash
npm run dev:simulations
```

Open http://127.0.0.1:5174.

## Checks

```bash
npm run build:sdk
npm run lint --workspace @the-drunken-coder/atlas-simulations
npm run format:check --workspace @the-drunken-coder/atlas-simulations -- --since=origin/main
npm test --workspace @the-drunken-coder/atlas-simulations
npm run typecheck --workspace @the-drunken-coder/atlas-simulations
npm run build:simulations
```
