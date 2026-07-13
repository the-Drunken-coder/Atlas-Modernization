import { render, screen } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "../../atlas/store.js";
import { EntityList } from "../EntityList.js";
import { AssetInspector } from "./AssetInspector.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

function asset(lastSeen?: string): EntityResource {
  return {
    entity_id: "asset-1",
    entity_type: "asset",
    subtype: null,
    alias: "Rover One",
    components: {
      communications: { link_state: "connected" },
      ...(lastSeen ? { heartbeat: { last_seen: lastSeen } } : {})
    },
    metadata
  };
}

describe("asset connection status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-06-20T00:10:00Z");
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["fresh", "2026-06-20T00:09:50Z", "Connected", "var(--link-connected)"],
    ["stale", "2026-06-20T00:09:00Z", "Reported connected — stale heartbeat", "var(--heartbeat-stale)"],
    ["offline", "2026-06-20T00:00:00Z", "Reported connected — offline", "var(--heartbeat-offline)"],
    ["missing", undefined, "Reported connected — never checked in", "var(--text-3)"]
  ] as const)("shows %s heartbeat qualification consistently", (_case, lastSeen, label, color) => {
    const entity = asset(lastSeen);
    const { unmount } = render(<EntityList entities={[entity]} emptyLabel="none" onSelect={() => {}} />);

    expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>(".entity-row__dot")).toHaveStyle({ background: color });
    unmount();

    render(<AssetInspector entity={entity} snapshot={emptySnapshot()} onPickCommand={() => {}} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
