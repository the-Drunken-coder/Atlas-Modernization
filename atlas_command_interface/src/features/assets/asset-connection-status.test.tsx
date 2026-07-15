import { act, render, screen } from "@testing-library/react";
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
    ["clock error", "2026-06-20T00:10:31Z", "Reported connected — clock error", "var(--text-3)"],
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

  it("updates the entity list when a fresh heartbeat becomes stale without a snapshot change", () => {
    render(<EntityList entities={[asset("2026-06-20T00:09:50Z")]} emptyLabel="none" onSelect={() => {}} />);
    expect(screen.getByText(/Connected/)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(21_000));

    expect(screen.getByText(/Reported connected — stale heartbeat/)).toBeInTheDocument();
  });

  it("updates the inspector through stale and offline thresholds without a snapshot change", () => {
    render(<AssetInspector entity={asset("2026-06-20T00:09:50Z")} snapshot={emptySnapshot()} onPickCommand={() => {}} />);
    expect(screen.getByText("Connected")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(21_000));
    expect(screen.getByText("Reported connected — stale heartbeat")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(90_000));
    expect(screen.getByText("Reported connected — offline")).toBeInTheDocument();
  });

  it("does not color a no-link asset from telemetry-only recency", () => {
    const entity = asset();
    entity.components = { telemetry: { last_update: "2026-06-20T00:09:50Z" } };

    render(<EntityList entities={[entity]} emptyLabel="none" onSelect={() => {}} />);

    expect(document.querySelector<HTMLElement>(".entity-row__dot")).toHaveStyle({ background: "var(--map-asset)" });
  });
});
