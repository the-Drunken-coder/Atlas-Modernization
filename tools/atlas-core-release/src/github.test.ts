import assert from "node:assert/strict";
import test from "node:test";

import { GitHubClient } from "./github.js";
import { requiredWorkflows } from "./release.js";

const sha = "a".repeat(40);

test("GitHub eligibility rejects an invalid SHA before building a request URL", async () => {
  let requests = 0;
  const client = new GitHubClient("owner/repository", "token", "https://api.example.invalid", {
    fetch: async () => {
      requests += 1;
      return json({});
    },
    now: () => 0,
    sleep: async () => undefined
  });

  await assert.rejects(client.eligibility(requiredWorkflows[0]!, `${sha}&event=pull_request`), /Invalid source SHA/);
  assert.equal(requests, 0);
});

test("the CI deadline retries transient GitHub API failures", async () => {
  let now = 0;
  let transientFailures = 1;
  const runIds = new Map(requiredWorkflows.map((workflow, index) => [workflow.path.split("/").at(-1), index + 1]));
  const client = new GitHubClient("owner/repository", "token", "https://api.example.invalid", {
    fetch: async (input) => {
      const url = new URL(input);
      if (transientFailures > 0) {
        transientFailures -= 1;
        return new Response("temporary upstream failure", { status: 503 });
      }
      const workflowMatch = url.pathname.match(/\/actions\/workflows\/([^/]+)\/runs$/u);
      if (workflowMatch) {
        const filename = decodeURIComponent(workflowMatch[1] ?? "");
        const requirement = requiredWorkflows.find((candidate) => candidate.path.endsWith(`/${filename}`));
        assert.ok(requirement);
        return json({
          workflow_runs: [
            {
              id: runIds.get(filename),
              run_attempt: 1,
              event: "push",
              head_sha: sha,
              path: requirement.path,
              status: "completed",
              conclusion: "success",
              html_url: `https://example.invalid/${filename}`
            }
          ]
        });
      }
      const jobMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/u);
      if (jobMatch) {
        const id = Number(jobMatch[1]);
        const requirement = requiredWorkflows[id - 1];
        assert.ok(requirement);
        return json({
          jobs: requirement.jobs.map((name) => ({ name, status: "completed", conclusion: "success" }))
        });
      }
      return new Response("not found", { status: 404 });
    },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    }
  });

  const result = await client.waitForRequiredCI(sha, 45_000);
  assert.equal(result.length, requiredWorkflows.length);
  assert.ok(result.every((eligibility) => eligibility.state === "success"));
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
