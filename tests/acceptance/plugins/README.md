# Plugin acceptance

Plugin acceptance runs real Plugin images through Atlas Core and the private Source Gateway. The shared runner owns a UUID Compose project, generated credentials, loopback Core port, PostgreSQL and MinIO volumes, diagnostics, and cleanup. Plugin scenarios add only their test-owned Compose overlay and use the acceptance run label to control an exact owned container during availability checks.

Run Reference acceptance from the repository root with Node 24 or newer and Docker Compose available:

```sh
npm ci
node tests/acceptance/plugins/reference/scenario.mjs
```

The command builds the actual Core development image, Source Gateway production target, Reference Plugin target, and Reference source target. The source target mounts a test-only deterministic fixture on an internal network shared only with Source Gateway; the Plugin stays on the default network. Its routed fixture checks therefore exercise the Gateway path. It makes no public provider request and does not use the fixed container names or network from the development Plugin Compose file.

Reference currently declares `inspect_fixture`. The scenario fails if the runtime manifest adds or removes an Operation without a success case. It verifies the returned fixture value, provenance, and freshness; invalid input; a controlled upstream error; malformed upstream JSON; request cancellation reaching the fixture; unavailability while the Plugin container is stopped; and recovery and invocation after that same container restarts. Error checks inspect both the SDK's sanitized public `error.response` and a cloned raw Core HTTP response: the wire response must contain the contract-required success flag, code, and message, and optional details, route, identity, and timestamp are checked when Core supplies them. The SDK payload intentionally omits the latter three metadata fields.

Artifacts are written under `.atlas/acceptance/reference-plugin/<run-id>/`. `run.json` records the revision, dirty state, fixture variant, reproduction command, and isolated project. `evidence.jsonl` contains every expected and actual observation. `plugin-stack-commands.jsonl` records bounded stop, start, and inspection commands. `commands.log`, `compose.log`, and `result.json` retain stack diagnostics and measured duration. Missing Node, Docker, Compose, built workspace dependencies, services, or expected test-owned containers fail the run. The runner does not retry scenario failures.

This journey checks one Plugin on the local Docker architecture. It does not replace the Plugin Runtime socket suite, Reference bundle test, Source Gateway policy tests, other Plugin acceptance, published-image verification, or public-provider monitoring.
