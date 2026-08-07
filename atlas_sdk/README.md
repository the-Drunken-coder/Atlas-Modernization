# Atlas SDK

The Atlas SDK is the typed TypeScript/JavaScript client for Atlas Core. It includes the resource client, sync engine, generated Atlas Protocol types and revision checks, browser admin client, and the `atlas` command-line tool.

Node.js 24 or newer is required.

## Install

```bash
npm install @the-drunken-coder/atlas-sdk
```

## Resource client

```ts
import { AtlasClient, ATLAS_PROTOCOL_REVISION, type EntityResource } from "@the-drunken-coder/atlas-sdk";

const client = new AtlasClient({
  baseUrl: "https://api.example.test",
  apiKey: process.env.ATLAS_API_KEY
});

await client.handshake();
const entity: EntityResource = await client.entities.get("asset-1");
console.log(ATLAS_PROTOCOL_REVISION, entity);
```

Protocol resource types, request validators, and `ATLAS_PROTOCOL_REVISION` are public from the package root. The client checks that revision against Atlas Core before normal API use.

## Admin client

```ts
import { AtlasAdminClient } from "@the-drunken-coder/atlas-sdk/admin";

const admin = new AtlasAdminClient({
  baseUrl: "https://api.example.test",
  credentials: "include"
});

await admin.auth.login({ username: "admin", password: "replace-me" });
```

The admin entry point covers operator sessions and managed API keys. Admin records do not enter the resource cache.

## CLI

```bash
atlas --base-url http://127.0.0.1:8000 --api-key "$ATLAS_API_KEY" entities get asset-1
atlas --base-url http://127.0.0.1:8000 tasks create '{"task_id":"task-1"}'
atlas --base-url http://127.0.0.1:8000 watch --subscribe all --follow
```

`ATLAS_BASE_URL` and `ATLAS_API_KEY` provide the corresponding defaults.

## Repository development

From the repository root:

```bash
npm ci
npm run build:sdk
npm run test:package --workspace @the-drunken-coder/atlas-sdk
npm run test:types --workspace @the-drunken-coder/atlas-sdk
npm test --workspace @the-drunken-coder/atlas-sdk
```

The package smoke test builds a clean tarball, installs it into a temporary consumer, compiles its public types, and exercises the root, admin, CLI, and generated protocol paths. See the [full SDK design documentation](https://github.com/the-Drunken-coder/Atlas-Modernization/blob/main/docs/atlas-sdk/README.md) for sync, cache, feed, and reconciliation details.
