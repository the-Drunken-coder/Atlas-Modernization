# Problem Report

1. **Time & Date:** 2026-08-30T14:57:47Z
2. **Name:** SDK CLI rounds unsafe task-input integers before sending them
3. **Issue:** `atlas tasks create <json>` parses the supplied task JSON with native `JSON.parse`, which converts an integer outside JavaScript's exact-integer range to a different number before the SDK serializer sends the request.
4. **Severity:** S3 (Moderate)
5. **Location:** `packages/sdk/src/cli.ts:153-158`, `packages/sdk/src/json.ts:3-6`, `services/core/internal/api/handlers/handler_response.go:254-257`, `services/core/internal/actions/task_create.go:43-45`
6. **Expected:** The CLI should either preserve the exact JSON integer lexeme through the request or reject it before making a request. It must not silently change task input data.
7. **Actual:** Native `JSON.parse` turns `9007199254740993` into `9007199254740992`. The resulting number is exactly representable, so the SDK's later `stringifyAtlasJSON` check does not reject it and sends the rounded value. Core's request path validates the raw JSON and decodes with `UseNumber`, so a direct HTTP caller can preserve the original integer.
8. **Reproduction:**
   1. From the repository root, run `npm run build:sdk` to generate the local SDK build used by the probe.
   2. Run `node --input-type=module` with the following script from the repository root (the fake fetch captures the request body):

      ```js
      import { runCLI } from "./packages/sdk/dist/packages/sdk/src/cli.js";
      let body;
      const revision =
        "sha256:0eaf01b2609251f8ac2c443e270b02e41259e9b2023a8b73a6a47df42d6255a5";
      const task = {
        task_id: "task-1",
        asset_id: "asset-1",
        command: "fixture.queued",
        input: { n: 9007199254740992 },
        status: "pending",
        created_at: "2026-08-30T00:00:00Z",
        updated_at: "2026-08-30T00:00:00Z",
      };
      const fetch = async (url, init) => {
        if ((init?.method ?? "GET") === "POST")
          body = await new Response(init.body).text();
        if (url.endsWith("/protocol/revision"))
          return new Response(JSON.stringify({ protocol_revision: revision }));
        return new Response(JSON.stringify(task), {
          status: 201,
          headers: { ETag: '"v1"' },
        });
      };
      let out = "",
        err = "";
      const io = {
        stdout: { write: (data) => (out += data) },
        stderr: { write: (data) => (err += data) },
        env: {},
        fetch,
      };
      const code = await runCLI(
        [
          "--base-url",
          "http://atlas.test",
          "--idempotency-key",
          "k",
          "tasks",
          "create",
          '{"asset_id":"asset-1","command":"fixture.queued","input":{"n":9007199254740993}}',
        ],
        io,
      );
      console.log(JSON.stringify({ code, body, out, err }));
      ```

   3. Observe the captured request body: `{"asset_id":"asset-1","command":"fixture.queued","input":{"n":9007199254740992}}`.
9. **Notes:** `parseAtlasJSON` in `packages/sdk/src/json.ts` already rejects unsafe integer lexemes, but the CLI bypasses it. The smallest fix is to use `parseAtlasJSON(raw)` in `parseArgs`; add a CLI regression test that captures the request body and verifies that this input is rejected before handshake/request (or otherwise preserves the exact value).
