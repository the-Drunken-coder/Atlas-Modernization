# SDK Object acceptance

Run this acceptance journey from the repository root with Node 24 or newer and a running Docker daemon:

```sh
npm ci
npm run build:sdk && node tests/acceptance/sdk-objects.mjs
```

The test starts the disposable Core, PostgreSQL, and MinIO stack through `support/stack.mjs`. It uploads deterministic binary fixtures through authenticated `POST /objects/upload`, then uses the built SDK to verify metadata and byte-for-byte downloads. It replaces the Object and verifies changed storage metadata and content, deletes it and verifies that both metadata and content are unavailable, then sends an incomplete multipart upload and verifies it never appears as a completed Object.

Each run writes its revision, command log, expected-versus-actual observations, and Core plus storage logs under `.atlas/acceptance/sdk-objects/`. The generated Compose project, ports, volumes, credentials, and artifacts are owned by that one run, so concurrent worktrees can run this command safely.
