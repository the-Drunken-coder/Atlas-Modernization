import { act, render, screen } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityFixture } from "../../../test/fixtures.js";
import { emptySnapshot } from "../../atlas/store.js";
import { EntityList } from "../EntityList.js";
import { AssetInspector } from "./AssetInspector.js";

function asset(lastSeen?: string): EntityResource {
  return entityFixture({
    entity_id: "asset-1",
    alias: "Rover One",
    components: {
      communications: { link_state: "connected" },
      ...(lastSeen ? { heartbeat: { last_seen: lastSeen } } : {})
    }
  });
}

function fieldValue(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new TypeError(`${label} field is missing its value`);
  return value;
}

describe("asset connection status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-06-20T00:10:00Z");
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["fresh", "2026-06-20T00:09:50Z", "Connected", "var(--link-connected)", "10s ago", "var(--heartbeat-fresh)"],
    [
      "stale",
      "2026-06-20T00:09:00Z",
      "Reported connected — stale heartbeat",
      "var(--heartbeat-stale)",
      "1m ago",
      "var(--heartbeat-stale)"
    ],
    [
      "offline",
      "2026-06-20T00:00:00Z",
      "Reported connected — offline",
      "var(--heartbeat-offline)",
      "10m ago",
      "var(--heartbeat-offline)"
    ],
    [
      "clock error",
      "2026-06-20T00:10:31Z",
      "Reported connected — clock error",
      "var(--text-3)",
      "Clock error",
      "var(--text-3)"
    ],
    ["missing", undefined, "Reported connected — never checked in", "var(--text-3)", undefined, undefined]
  ] as const)(
    "shows %s heartbeat qualification consistently",
    (_case, lastSeen, label, color, heartbeatLabel, heartbeatColor) => {
      const entity = asset(lastSeen);
      const { unmount } = render(
        <EntityList entities={[entity]} query="" emptyLabel="none" onSelect={() => {}} onQueryChange={() => {}} />
      );

      expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
      expect(document.querySelector<HTMLElement>(".entity-row__dot")).toHaveStyle({ background: color });
      unmount();

      render(<AssetInspector entity={entity} snapshot={emptySnapshot()} onPickCommand={() => {}} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      const heartbeat = fieldValue("Heartbeat");
      if (heartbeatLabel && heartbeatColor) {
        expect(heartbeat).toHaveTextContent(heartbeatLabel);
        expect(heartbeat.querySelector(".pill")).toHaveStyle(`--pill-accent: ${heartbeatColor}`);
      } else {
        expect(heartbeat).toHaveTextContent("—");
        expect(heartbeat.querySelector(".pill")).toBeNull();
      }
    }
  );

  it("updates the entity list when a fresh heartbeat becomes stale without a snapshot change", () => {
    render(
      <EntityList
        entities={[asset("2026-06-20T00:09:50Z")]}
        query=""
        emptyLabel="none"
        onSelect={() => {}}
        onQueryChange={() => {}}
      />
    );
    expect(screen.getByText(/Connected/)).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(21_000));

    expect(screen.getByText(/Reported connected — stale heartbeat/)).toBeInTheDocument();
  });

  it("updates the inspector through stale and offline thresholds without a snapshot change", () => {
    render(
      <AssetInspector entity={asset("2026-06-20T00:09:50Z")} snapshot={emptySnapshot()} onPickCommand={() => {}} />
    );
    expect(screen.getByText("Connected")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(21_000));
    expect(screen.getByText("Reported connected — stale heartbeat")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(90_000));
    expect(screen.getByText("Reported connected — offline")).toBeInTheDocument();
  });

  it("does not color a no-link asset from telemetry-only recency", () => {
    const entity = asset();
    entity.components = { telemetry: { last_update: "2026-06-20T00:09:50Z" } };

    render(<EntityList entities={[entity]} query="" emptyLabel="none" onSelect={() => {}} onQueryChange={() => {}} />);

    expect(document.querySelector<HTMLElement>(".entity-row__dot")).toHaveStyle({ background: "var(--map-asset)" });
  });
});
