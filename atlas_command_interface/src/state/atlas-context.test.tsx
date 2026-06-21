import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { AtlasProvider, useAtlas } from "./atlas-context.js";

function StatusProbe() {
  const atlas = useAtlas();
  return (
    <div>
      <span>{atlas.status}</span>
      {atlas.error ? <code>{atlas.error}</code> : null}
    </div>
  );
}

describe("AtlasProvider", () => {
  it("cleans up subscriptions and data source state when startup fails", async () => {
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const fake: AtlasDataSource = {
      async loadSnapshot() {
        return { entities: [], tasks: [] };
      },
      async loadCommandCatalog() {
        throw new Error("catalog unavailable");
      },
      watch() {
        return unsubscribe;
      },
      async start() {
        throw new Error("start failed");
      },
      async submitCommand() {
        throw new Error("not used");
      },
      async updateGeometry() {
        throw new Error("not used");
      },
      dispose
    };

    render(
      <AtlasProvider loadConfig={async () => ({ atlasBaseUrl: "/atlas", protocolRevision: "rev" })} createDataSource={() => fake}>
        <StatusProbe />
      </AtlasProvider>
    );

    expect(await screen.findByText("error")).toBeInTheDocument();
    expect(screen.getByText("start failed")).toBeInTheDocument();
    await waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });
});
