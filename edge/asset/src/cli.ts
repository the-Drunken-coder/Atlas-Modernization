#!/usr/bin/env node
import { AtlasClient } from "@the-drunken-coder/atlas-sdk";
import { loadAssetConfig } from "./config.js";
import { AssetController } from "./controller.js";
import { CoreAttachment } from "./core-client.js";
import { openSerialLink, openTcpLink } from "./mavlink-link.js";
import { TaskEngine } from "./task-engine.js";
import { VehicleTracker } from "./vehicle.js";

function usage(): string {
  return "Usage: atlas-asset --config <path-to-config.toml>";
}

function configPath(argv: string[]): string {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--config" || argv[index] === "-c") {
      const value = argv[index + 1];
      if (value !== undefined) return value;
    }
  }
  throw new Error(usage());
}

function log(level: "info" | "warn" | "error", message: string): void {
  const prefix = level === "info" ? "info" : level;
  // eslint-disable-next-line no-console
  console.log(`${new Date().toISOString()} [${prefix}] ${message}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Configuration loads once at startup; file edits never change behavior
  // while the process runs.
  const config = await loadAssetConfig(configPath(argv));
  log("info", `Asset ${config.assetId}: connecting to Core at ${config.coreUrl}.`);

  const tracker = new VehicleTracker();
  const core = new CoreAttachment(
    config,
    new AtlasClient({ baseUrl: config.coreUrl, apiKey: config.apiKey, sync: false })
  );
  const engine = new TaskEngine(
    {
      send: async (message) => {
        if (link === undefined) throw new Error("MAVLink link is not open");
        await link.send(message);
      }
    },
    {
      reportStart: (taskId) => core.reportStart(taskId),
      reportProgress: (taskId, progress) => core.reportProgress(taskId, progress),
      reportComplete: (taskId) => core.reportComplete(taskId),
      reportFail: (taskId, code, message) => core.reportFail(taskId, code, message)
    },
    config
  );

  let link: import("./mavlink-link.js").MavLink | undefined;
  const controller = new AssetController(config, {
    openLink: async () => {
      // GCS identity is fixed per process; the vehicle identity is verified
      // against configuration before flight readiness.
      const sysid = 255;
      const compid = 190;
      link =
        config.link.transport === "tcp"
          ? await openTcpLink(config.link.host, config.link.port, sysid, compid)
          : await openSerialLink(config.link.port, config.link.baud, sysid, compid);
      return link;
    },
    core,
    engine,
    tracker,
    log
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", `Received ${signal}; requesting a graceful shutdown.`);
    try {
      await controller.shutdown();
    } catch (error) {
      log("error", `Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await controller.start();
  } catch (error) {
    log("error", `${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
