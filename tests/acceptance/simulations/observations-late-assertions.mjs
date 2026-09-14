import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { runAcceptance } from "../support/stack.mjs";
import { createSimulationServerFixture } from "./support/server-fixture.mjs";
import {
  eventStreamResponseError,
  parseBrowserRunEventFrame,
} from "./support/sse-response-contract.mjs";

const reproduction =
  "npm run build:sdk && node --import ./simulations/node_modules/tsx/dist/loader.mjs tests/acceptance/simulations/observations-late-assertions.mjs";
const launcher = fileURLToPath(
  new URL("./support/late-assertion-server-launcher.mjs", import.meta.url),
);
const fixture = createSimulationServerFixture({ serverEntrypoint: launcher });

await runAcceptance({
  name: "simulations-observations-late-assertions",
  reproduction,
  fixtureVariant: {
    name: "real-simulations-server-late-assertion-fault",
    fault: "bounded verifier reads pause after the final observation",
    expected_product_result: "no assertions after cancelled stream terminal",
  },
  prepare: fixture.prepare,
  run: async ({ baseUrl, apiKey, artifacts, record, signal }) => {
    const simulation = await fixture.start({
      coreBaseUrl: baseUrl,
      apiKey,
      signal,
    });
    const started = await requestJSON(simulation.url, "/api/runs", {
      method: "POST",
      body: JSON.stringify({
        scenarioId: "observations-objects",
        targetId: "local",
        inputs: {
          assetCount: 2,
          observations: 1,
          tickMs: 50,
          startLatitude: 38.8123,
          startLongitude: -77.1634,
        },
      }),
      signal,
    });
    const runID = started.body?.run?.id;
    if (started.status !== 201 || typeof runID !== "string") {
      throw new Error(
        `Late-assertion fault could not start observations: ${started.raw}`,
      );
    }
    writeFileSync(
      join(artifacts, "late-assertion-start.json"),
      `${JSON.stringify(started, null, 2)}\n`,
    );

    const terminal = await collectBrowserTerminalStream({
      baseUrl: simulation.url,
      runID,
      artifacts,
      signal,
    });
    const summary = await readUntilAssertions({
      baseUrl: simulation.url,
      runID,
      artifacts,
      signal,
    });
    const browserAssertions = terminal.events
      .filter((event) => event.type === "assertion")
      .map((event) => event.assertion);
    const terminalEvent = terminal.events.at(-1);
    record({
      check:
        "cancelled browser stream and later summary retain the same assertion evidence",
      expected: {
        terminal: { status: "cancelled", message: "Stop requested" },
        browser_assertions: [],
        summary_assertions: [],
      },
      actual: {
        terminal_event:
          terminalEvent?.type === "status"
            ? { status: terminalEvent.status, message: terminalEvent.message }
            : terminalEvent,
        browser_assertions: browserAssertions,
        summary_assertions: summary.assertions,
      },
      passed:
        terminalEvent?.type === "status" &&
        terminalEvent.status === "cancelled" &&
        terminalEvent.message === "Stop requested" &&
        browserAssertions.length === 0 &&
        summary.assertions.length === 0,
    });
  },
});

async function collectBrowserTerminalStream({
  baseUrl,
  runID,
  artifacts,
  signal,
}) {
  const events = [];
  let raw = "";
  let stopResponse;
  let reader;
  try {
    const response = await fetch(
      `${baseUrl}/api/runs/${encodeURIComponent(runID)}/events`,
      {
        headers: { Accept: "text/event-stream" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    );
    const responseError = eventStreamResponseError(response);
    if (responseError) {
      raw = await response.text();
      throw new Error(`${responseError}: ${raw}`);
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const result = await reader.read();
      if (result.done)
        throw new Error("Browser stream ended before its terminal status");
      const text = decoder.decode(result.value, { stream: true });
      raw += text;
      pending += text;
      let separator = pending.indexOf("\n\n");
      while (separator !== -1) {
        const event = parseEventFrame(pending.slice(0, separator));
        pending = pending.slice(separator + 2);
        if (event) {
          events.push(event);
          if (
            stopResponse === undefined &&
            event.type === "log" &&
            event.message.startsWith("Observation 1 linked ")
          ) {
            stopResponse = await requestJSON(
              baseUrl,
              `/api/runs/${encodeURIComponent(runID)}/stop`,
              { method: "POST", signal },
            );
          }
          if (event.type === "status" && event.status !== "running") {
            await reader.cancel();
            return { events, stopResponse };
          }
        }
        separator = pending.indexOf("\n\n");
      }
    }
  } finally {
    await reader?.cancel();
    writeFileSync(join(artifacts, "late-assertion-browser-terminal.sse"), raw);
    writeFileSync(
      join(artifacts, "late-assertion-browser-terminal.events.json"),
      `${JSON.stringify(events, null, 2)}\n`,
    );
    writeFileSync(
      join(artifacts, "late-assertion-stop.json"),
      `${JSON.stringify(stopResponse, null, 2)}\n`,
    );
  }
}

async function readUntilAssertions({ baseUrl, runID, artifacts, signal }) {
  const deadline = Date.now() + 5_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await requestJSON(
      baseUrl,
      `/api/runs/${encodeURIComponent(runID)}`,
      { signal, timeoutMs: Math.max(1, deadline - Date.now()) },
    );
    if (
      latest.status === 200 &&
      Array.isArray(latest.body?.run?.assertions) &&
      latest.body.run.assertions.length > 0
    )
      break;
    await delay(25, undefined, { signal });
  }
  if (latest?.status !== 200 || !Array.isArray(latest.body?.run?.assertions)) {
    throw new Error(
      `Late-assertion fault did not return a run summary: ${latest?.raw}`,
    );
  }
  writeFileSync(
    join(artifacts, "late-assertion-summary.json"),
    `${JSON.stringify(latest, null, 2)}\n`,
  );
  return latest.body.run;
}

async function requestJSON(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers:
      options.method === "POST"
        ? {
            "x-atlas-simulations-request": "1",
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          }
        : undefined,
    body: options.body,
    signal: AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.timeoutMs ?? 15_000),
    ]),
  });
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, raw };
}

function parseEventFrame(frame) {
  return parseBrowserRunEventFrame(frame);
}
