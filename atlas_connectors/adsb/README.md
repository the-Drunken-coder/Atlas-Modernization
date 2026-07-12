# ADS-B Connector Prototype

This is a local, taskable Atlas Connector that requires no Atlas Core changes. It registers itself as an `asset` with subtype `connector`, checks in for pending work, accepts an ordinary Atlas `scan_area` task, and publishes deterministic demo aircraft tracks inside the requested bounds.

It does not call a real ADS-B provider yet. The prototype proves the Atlas-side lifecycle before adding a paid upstream API.

## Run locally

Use Node 24 from the repository root:

```bash
nvm use
npm ci
cp atlas_connectors/adsb/.env.example atlas_connectors/adsb/.env
npm run dev:connector-adsb -- run
```

Set `ATLAS_API_KEY` in the ignored `.env`; the current SDK handshake uses Core's protected protocol-revision route. The default Core URL is `http://127.0.0.1:8000`.

In a second terminal, submit a scan job:

```bash
npm run dev:connector-adsb -- scan --north 39.1 --south 38.7 --east -76.8 --west -77.3 --count 3
```

The running connector acknowledges the task, publishes up to ten reusable `track` entities, completes the task with the track IDs, and returns to `ready`. Repeating a scan updates the same demo tracks instead of growing the dataset.

Use `run --once` for a single check-in pass.

## Run as a container

From the repository root:

```bash
export ATLAS_API_KEY="your-local-or-managed-key"
docker compose -f atlas_connectors/docker-compose.yml up --build adsb
```

On macOS the container defaults to `http://host.docker.internal:8000`. Override `ATLAS_BASE_URL` to target a different Core explicitly.

## Why this uses an ordinary task

Atlas Core owns the command catalog. Adding `scan_area` to that catalog would change Core, so the prototype carries the action in `components.custom_connector` on an ordinary task. A later production design can decide whether connector actions belong in the shared command catalog without blocking this proof.
