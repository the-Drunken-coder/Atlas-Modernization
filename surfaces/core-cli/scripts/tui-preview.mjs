#!/usr/bin/env node
import { createInteractiveCLI } from "../dist/terminal-ui.js";

const allowedStates = new Set(["ready", "stopped", "degraded", "not-initialized"]);
const stateArgument = process.argv.indexOf("--state");
const initialState = stateArgument >= 0 ? process.argv[stateArgument + 1] : "ready";
if (!allowedStates.has(initialState)) {
  process.stderr.write(`Unknown preview state: ${initialState ?? ""}\n`);
  process.exitCode = 2;
} else {
  let deploymentState = initialState;
  const startedAt = "2026-08-28T12:00:00.000Z";

  const snapshot = () => {
    if (deploymentState === "ready") return { status: "ready", detail: "Everything is healthy." };
    if (deploymentState === "stopped")
      return { status: "stopped", detail: "Atlas Core is stopped. Durable storage is preserved." };
    if (deploymentState === "not-initialized") {
      return { status: "not-initialized", detail: "Initialize Atlas Core on this host." };
    }
    return { status: "degraded", detail: "Core API is running, but MinIO health is unavailable." };
  };

  const services = () => {
    if (deploymentState === "stopped" || deploymentState === "not-initialized") return [];
    return [
      service("api", "Core API", "api", "1.00%", "128MiB / 1GiB", "12.50%", "12"),
      service("source-gateway", "Source Gateway", "source_gateway", "0.20%", "42MiB / 1GiB", "4.10%", "6"),
      service("postgres", "PostgreSQL", "postgres", "2.00%", "256MiB / 1GiB", "25.00%", "13"),
      service(
        "minio",
        "MinIO",
        "minio",
        "3.00%",
        "192MiB / 1GiB",
        "18.75%",
        "14",
        deploymentState === "degraded" ? "unhealthy" : "healthy"
      )
    ];
  };

  const preview = (message) => process.stdout.write(`[preview only] ${message}\n`);
  const operator = {
    async checkForUpdates() {
      return {
        cliVersion: "0.1.5",
        coreVersion: deploymentState === "not-initialized" ? undefined : "0.1.5",
        latestVersion: "0.1.6",
        cliUpdateAvailable: true,
        coreUpdateAvailable: deploymentState !== "not-initialized"
      };
    },
    async configureAdminPassword() {
      preview("Admin password accepted by the fixture. Nothing was stored.");
    },
    async details() {
      return {
        snapshot: snapshot(),
        cliVersion: "0.1.5",
        coreVersion: deploymentState === "not-initialized" ? "Not initialized" : "0.1.5",
        initializedAt: deploymentState === "not-initialized" ? "Not initialized" : startedAt,
        apiEndpoint: "http://127.0.0.1:8000",
        minioEndpoint: "http://127.0.0.1:9001",
        image:
          deploymentState === "not-initialized" ? undefined : "ghcr.io/the-drunken-coder/atlas-core@sha256:cfe582…",
        services: services(),
        performanceError: deploymentState === "degraded" ? "MinIO did not return Docker statistics." : undefined
      };
    },
    async doctor() {
      preview("Docker daemon: fixture healthy");
      preview("Compose 2.17+: fixture healthy");
      preview("Deployment ownership: fixture matched");
      return true;
    },
    async init() {
      preview("Initialization simulated. No credentials, containers, or volumes were created.");
      deploymentState = "ready";
    },
    async logs(serviceId) {
      const label = serviceId ?? "all services";
      preview(`Showing fixture logs for ${label}.`);
      process.stdout.write("2026-08-30T14:12:03Z core-api ready on 127.0.0.1:8000\n");
      process.stdout.write("2026-08-30T14:12:04Z source-gateway no connectors configured\n");
      process.stdout.write("2026-08-30T14:12:05Z postgres accepting connections\n");
      process.stdout.write("2026-08-30T14:12:06Z minio bucket atlas ready\n");
    },
    async reset() {
      preview("Reset simulated. No credentials, containers, or volumes were deleted.");
      deploymentState = "ready";
    },
    async restart() {
      preview("Restart simulated. No images were pulled and no containers changed.");
      deploymentState = "ready";
    },
    async snapshot() {
      return snapshot();
    },
    async start() {
      preview("Start simulated. No containers changed.");
      deploymentState = "ready";
    },
    async status() {
      preview("Status command simulated.");
      return deploymentState === "ready";
    },
    async stop() {
      preview("Stop simulated. No containers changed.");
      deploymentState = "stopped";
    },
    async update(scope) {
      preview(`${scope === "all" ? "CLI and Core" : "CLI-only"} update simulated. Nothing was installed.`);
    }
  };

  try {
    await createInteractiveCLI().runMenu(operator);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function service(id, label, containerSuffix, cpuPercent, memoryUsage, memoryPercent, processes, health = "healthy") {
  return {
    id,
    label,
    container: `atlas_core_production_${containerSuffix}`,
    state: "running",
    health,
    cpuPercent,
    memoryUsage,
    memoryPercent,
    networkIO: "1MB / 2MB",
    blockIO: "3MB / 4MB",
    processes,
    uptime: "4d 2h",
    restarts: 0,
    image: "ghcr.io/the-drunken-coder/atlas-core@sha256:cfe582…"
  };
}
