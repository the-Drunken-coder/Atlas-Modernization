import assert from "node:assert/strict";
import test from "node:test";

import { cloneJSONValue, runFixtureHook, validateComposeConfig } from "./stack.mjs";

const project = "atlas_acceptance_fixture-test";
const corePort = 45678;

function baseComposeConfig() {
  return {
    name: project,
    services: {
      api: {
        ports: [{ host_ip: "127.0.0.1", published: String(corePort), target: 8000, protocol: "tcp" }]
      },
      postgres: {
        volumes: [{ type: "volume", source: "postgres_data", target: "/var/lib/postgresql/data" }]
      }
    },
    volumes: {
      postgres_data: { name: `${project}_postgres_data` }
    },
    networks: {
      default: { name: `${project}_default` }
    }
  };
}

test("cloneJSONValue rejects values that cannot be recorded as JSON", () => {
  assert.deepEqual(cloneJSONValue({ fixture: "local" }, "fixture variant"), { fixture: "local" });
  assert.throws(() => cloneJSONValue(1n, "fixture variant"), /fixture variant must be valid JSON/);

  const circular = {};
  circular.self = circular;
  assert.throws(() => cloneJSONValue(circular, "fixture variant"), /fixture variant must be valid JSON/);
});

test("runFixtureHook propagates an abort to a pending hook", async () => {
  const controller = new AbortController();
  const pending = runFixtureHook(
    "fixture preparation",
    (signal) =>
      new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    controller.signal
  );
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("validateComposeConfig accepts only project-owned acceptance resources", () => {
  assert.doesNotThrow(() => validateComposeConfig(baseComposeConfig(), { project, corePort }));

  const extraPort = baseComposeConfig();
  extraPort.services.worker = { ports: [{ host_ip: "127.0.0.1", published: "45679", target: 8080 }] };
  assert.throws(() => validateComposeConfig(extraPort, { project, corePort }), /cannot publish a host port/);

  const externalVolume = baseComposeConfig();
  externalVolume.volumes.shared = { name: "shared", external: true };
  assert.throws(() => validateComposeConfig(externalVolume, { project, corePort }), /not runner-owned/);

  const bindMount = baseComposeConfig();
  bindMount.services.worker = { volumes: [{ type: "bind", source: "/tmp/fixture", target: "/fixture" }] };
  assert.throws(() => validateComposeConfig(bindMount, { project, corePort }), /cannot bind host paths/);
});
