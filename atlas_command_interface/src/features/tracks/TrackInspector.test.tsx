import { render, screen } from "@testing-library/react";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entityFixture } from "../../../test/fixtures.js";
import { TrackInspector } from "./TrackInspector.js";

function track(components: EntityResource["components"] = {}, alias: string | null = null): EntityResource {
  return entityFixture({ entity_id: "track-1", entity_type: "track", alias, components });
}

function fieldValue(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new TypeError(`${label} field is missing its value`);
  return value;
}

describe("TrackInspector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-06-20T00:10:00Z");
  });
  afterEach(() => vi.useRealTimers());

  it("renders telemetry at fixed precision and prefers the alias for the heading", () => {
    render(
      <TrackInspector
        entity={track(
          {
            telemetry: {
              latitude: 47.123456,
              longitude: -122.987654,
              altitude_m: 1234.6,
              heading_deg: 87.4,
              speed_m_s: 12.34,
              last_update: "2026-06-20T00:09:00Z"
            },
            mil_view: { classification: "hostile" }
          },
          "Bogey One"
        )}
      />
    );

    expect(screen.getByText("Bogey One")).toBeInTheDocument();
    expect(screen.getByText("track-1")).toBeInTheDocument();
    // Coordinates are fixed to 5 decimals; position is [lon, lat] internally.
    expect(fieldValue("Latitude")).toHaveTextContent("47.12346");
    expect(fieldValue("Longitude")).toHaveTextContent("-122.98765");
    expect(fieldValue("Altitude")).toHaveTextContent("1235 m");
    expect(fieldValue("Heading")).toHaveTextContent("87 °");
    expect(fieldValue("Speed")).toHaveTextContent("12.3 m/s");
    expect(fieldValue("Last update")).toHaveTextContent("1m ago");
    expect(screen.getByText("Hostile")).toBeInTheDocument();
  });

  it("falls back to the entity id and em dashes when telemetry is absent", () => {
    render(<TrackInspector entity={track()} />);

    // No alias: the heading shows the raw id, which also appears as the id line.
    expect(screen.getAllByText("track-1")).toHaveLength(2);
    expect(fieldValue("Latitude")).toHaveTextContent("—");
    expect(fieldValue("Longitude")).toHaveTextContent("—");
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
  });
});
