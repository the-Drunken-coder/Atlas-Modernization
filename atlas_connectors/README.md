# Atlas Connectors

Atlas connectors are independently runnable digital assets. They connect to Atlas Core through the public SDK, check in like other assets, accept Atlas tasks, and publish ordinary Atlas entities.

Each connector owns its runtime and failure boundary. A connector may live in this monorepo and share the root npm lockfile, but it must not import Atlas Core internals or require Core changes.

The first prototype is [`adsb/`](adsb/README.md).
