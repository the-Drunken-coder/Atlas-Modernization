import type { Eligibility, RequiredWorkflow, WorkflowJob, WorkflowRun } from "./release.js";
import { evaluateWorkflow, objectValue, requiredWorkflows, stringValue } from "./release.js";

interface GitHubClientDependencies {
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

class TransientGitHubError extends Error {}

const defaultDependencies: GitHubClientDependencies = {
  fetch: async (input, init) => fetch(input, init),
  now: () => Date.now(),
  sleep: async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds))
};

export class GitHubClient {
  readonly #repository: string;
  readonly #token: string;
  readonly #apiRoot: string;
  readonly #dependencies: GitHubClientDependencies;

  constructor(
    repository: string,
    token: string,
    apiRoot = "https://api.github.com",
    dependencies: GitHubClientDependencies = defaultDependencies
  ) {
    if (!/^[^/]+\/[^/]+$/u.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
    if (!token) throw new Error("A GitHub token is required");
    this.#repository = repository;
    this.#token = token;
    this.#apiRoot = apiRoot;
    this.#dependencies = dependencies;
  }

  async eligibility(requirement: RequiredWorkflow, sourceSha: string): Promise<Eligibility> {
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error(`Invalid source SHA: ${sourceSha}`);
    const workflowFile = requirement.path.split("/").at(-1);
    if (!workflowFile) throw new Error(`Invalid workflow path: ${requirement.path}`);
    const workflow = encodeURIComponent(workflowFile);
    const response = objectValue(
      await this.#get(
        `/repos/${this.#repository}/actions/workflows/${workflow}/runs?event=push&head_sha=${encodeURIComponent(sourceSha)}&per_page=20`
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
    if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error(`Invalid source SHA: ${sourceSha}`);
    const deadline = this.#dependencies.now() + timeoutMs;
    for (;;) {
      let results: Eligibility[];
      try {
        results = await Promise.all(requiredWorkflows.map((workflow) => this.eligibility(workflow, sourceSha)));
      } catch (error) {
        if (!(error instanceof TransientGitHubError) || this.#dependencies.now() >= deadline) throw error;
        await this.#dependencies.sleep(Math.min(15_000, Math.max(0, deadline - this.#dependencies.now())));
        continue;
      }
      const blocked = results.find((result) => result.state === "blocked");
      if (blocked) throw new Error(blocked.reason);
      if (results.every((result) => result.state === "success")) return results;
      if (this.#dependencies.now() >= deadline) {
        const pending = results.filter((result) => result.state === "pending").map((result) => result.reason);
        throw new Error(`Required Core CI did not complete before the deadline:\n${pending.join("\n")}`);
      }
      await this.#dependencies.sleep(Math.min(15_000, Math.max(0, deadline - this.#dependencies.now())));
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
    let response: Response;
    try {
      response = await this.#dependencies.fetch(`${this.#apiRoot}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new TransientGitHubError(
        `GitHub API transport failure for ${path}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const detail = await response.text();
      const message = `GitHub API ${response.status} for ${path}: ${detail}`;
      if (
        [408, 429, 500, 502, 503, 504].includes(response.status) ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" || /secondary rate limit/iu.test(detail)))
      ) {
        throw new TransientGitHubError(message);
      }
      throw new Error(message);
    }
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
