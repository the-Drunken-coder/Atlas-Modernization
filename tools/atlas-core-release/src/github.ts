import type { Eligibility, RequiredWorkflow, WorkflowJob, WorkflowRun } from "./release.js";
import { evaluateWorkflow, objectValue, requiredWorkflows, stringValue } from "./release.js";

export class GitHubClient {
  readonly #repository: string;
  readonly #token: string;
  readonly #apiRoot: string;

  constructor(repository: string, token: string, apiRoot = "https://api.github.com") {
    if (!/^[^/]+\/[^/]+$/u.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
    if (!token) throw new Error("A GitHub token is required");
    this.#repository = repository;
    this.#token = token;
    this.#apiRoot = apiRoot;
  }

  async eligibility(requirement: RequiredWorkflow, sourceSha: string): Promise<Eligibility> {
    const workflowFile = requirement.path.split("/").at(-1);
    if (!workflowFile) throw new Error(`Invalid workflow path: ${requirement.path}`);
    const workflow = encodeURIComponent(workflowFile);
    const response = objectValue(
      await this.#get(
      `/repos/${this.#repository}/actions/workflows/${workflow}/runs?event=push&head_sha=${sourceSha}&per_page=20`
      ),
      "GitHub workflow runs response"
    );
    const runs = parseWorkflowRuns(response.workflow_runs);
    const jobs = new Map<number, readonly WorkflowJob[]>();
    for (const run of runs) {
      if (
        run.path === requirement.path &&
        run.event === "push" &&
        run.head_sha === sourceSha &&
        run.status === "completed"
      ) {
        const jobResponse = objectValue(
          await this.#get(`/repos/${this.#repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`),
          "GitHub workflow jobs response"
        );
        jobs.set(run.id, parseWorkflowJobs(jobResponse.jobs));
      }
    }
    return evaluateWorkflow(requirement, sourceSha, runs, jobs);
  }

  async waitForRequiredCI(sourceSha: string, timeoutMs: number): Promise<Eligibility[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const results = await Promise.all(requiredWorkflows.map((workflow) => this.eligibility(workflow, sourceSha)));
      const blocked = results.find((result) => result.state === "blocked");
      if (blocked) throw new Error(blocked.reason);
      if (results.every((result) => result.state === "success")) return results;
      if (Date.now() >= deadline) {
        const pending = results.filter((result) => result.state === "pending").map((result) => result.reason);
        throw new Error(`Required Core CI did not complete before the deadline:\n${pending.join("\n")}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, Math.max(0, deadline - Date.now()))));
    }
  }

  async requireImmutableReleases(): Promise<void> {
    const response = objectValue(
      await this.#get(`/repos/${this.#repository}/immutable-releases`),
      "GitHub immutable releases response"
    );
    if (response.enabled !== true) {
      throw new Error("GitHub immutable releases must be enabled before reserving or publishing Atlas Core");
    }
  }

  async #get(path: string): Promise<unknown> {
    const response = await fetch(`${this.#apiRoot}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}: ${await response.text()}`);
    return await response.json();
  }
}

function parseWorkflowRuns(value: unknown): WorkflowRun[] {
  if (!Array.isArray(value)) throw new Error("GitHub workflow runs must be an array");
  return value.map((item, index) => {
    const run = objectValue(item, `GitHub workflow run ${index}`);
    return {
      id: integerValue(run.id, `GitHub workflow run ${index} ID`),
      run_attempt: integerValue(run.run_attempt, `GitHub workflow run ${index} attempt`),
      event: stringValue(run.event, `GitHub workflow run ${index} event`),
      head_sha: stringValue(run.head_sha, `GitHub workflow run ${index} SHA`),
      path: stringValue(run.path, `GitHub workflow run ${index} path`),
      status: stringValue(run.status, `GitHub workflow run ${index} status`),
      conclusion: nullableString(run.conclusion, `GitHub workflow run ${index} conclusion`),
      html_url: stringValue(run.html_url, `GitHub workflow run ${index} URL`)
    };
  });
}

function parseWorkflowJobs(value: unknown): WorkflowJob[] {
  if (!Array.isArray(value)) throw new Error("GitHub workflow jobs must be an array");
  return value.map((item, index) => {
    const job = objectValue(item, `GitHub workflow job ${index}`);
    return {
      name: stringValue(job.name, `GitHub workflow job ${index} name`),
      status: stringValue(job.status, `GitHub workflow job ${index} status`),
      conclusion: nullableString(job.conclusion, `GitHub workflow job ${index} conclusion`)
    };
  });
}

function integerValue(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringValue(value, label);
}
