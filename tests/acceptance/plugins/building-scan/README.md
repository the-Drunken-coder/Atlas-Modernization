# Building Scan acceptance

Run the scenario from the repository root with Node 24 or newer and Docker Compose:

```sh
npm ci
node tests/acceptance/plugins/building-scan/scenario.mjs
```

The scenario starts a UUID-owned Core, PostgreSQL, MinIO, Source Gateway, Building Scan Plugin, and local Overpass-compatible source. The source runs only on an internal network shared with Source Gateway. Building Scan runs only on Core's default network, so every fixture response crosses the real Plugin-to-Gateway path. The test never contacts a public Overpass provider or a deployed Atlas stack.

The required journey verifies the runtime manifest and its declared `search_buildings` Operation. It sends a fixed map area and checks the returned feature, geometry, attribution, provenance, and retrieval timestamp. It also checks invalid map-area input, malformed source geometry, a controlled source outage, caller cancellation during a slow request, Plugin unavailability, and recovery after the same owned container restarts. Error assertions inspect the SDK payload and a cloned raw Core response. Core may omit error route, identity, timestamp, and details metadata, so those fields are checked when present.

Set `ATLAS_BUILDING_SCAN_FIXTURE_MODE=nightly` to add two bounded source failures: an upstream `429` and an HTTP `200` Overpass timeout remark. The CI workflow uses that mode only for its scheduled run.

Artifacts are written to `.atlas/acceptance/building-scan-plugin/<run-id>/`. `run.json` records the revision, fixture mode, command, and Compose project. `evidence.jsonl` records each expected and actual outcome. `commands.log`, `compose.log`, `plugin-stack-commands.jsonl`, and `result.json` retain diagnostics. Missing Node, Docker, Compose, workspace builds, services, or test-owned containers fail explicitly.

This is local-container evidence on the Docker architecture in use. It complements focused Building Scan parser tests, Source Gateway policy tests, and published-image checks. It does not prove public-provider availability.
