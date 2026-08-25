import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { type ComponentProps, useReducer, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { entityFixture } from "../../../test/fixtures.js";
import { EntityList } from "../../features/EntityList.js";
import { initialSidebarState, sidebarReducer } from "../../state/selection.js";
import { SidebarPanel } from "./SidebarPanel.js";
import { SidebarRail } from "./SidebarRail.js";

const ASSETS: EntityResource[] = [
  entityFixture({ entity_id: "asset-1", alias: "Rover One" }),
  entityFixture({ entity_id: "asset-2", alias: "Rover Two" })
];

function Harness({ entities = ASSETS }: { entities?: EntityResource[] } = {}) {
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const [query, setQuery] = useState("");

  return (
    <>
      <button
        type="button"
        onClick={() => dispatch({ type: "selectEntity", kind: "asset", id: "asset-1", origin: "map" })}
      >
        Map
      </button>
      {state.selection ? (
        <button type="button" onClick={() => dispatch({ type: "clearSelection" })}>
          Close inspector
        </button>
      ) : null}
      <SidebarRail
        collapsed={state.collapsed}
        activeList={state.list}
        counts={{ asset: entities.length, track: 0, geofeature: 0 }}
        onSelectList={(list) => dispatch({ type: "openList", list })}
        onToggleCollapsed={() => dispatch({ type: "toggleCollapsed" })}
      />
      {state.collapsed ? null : (
        <SidebarPanel
          title={`LIST:${state.list}`}
          onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
        >
          {state.list === "assets" ? (
            <EntityList
              entities={entities}
              selectedId={state.selection?.id}
              restoreFocusId={state.restoreFocusId ?? undefined}
              query={query}
              emptyLabel="none"
              onSelect={(entity) =>
                dispatch({ type: "selectEntity", kind: "asset", id: entity.entity_id, origin: "sidebar" })
              }
              onQueryChange={setQuery}
            />
          ) : (
            <div>list {state.list}</div>
          )}
        </SidebarPanel>
      )}
    </>
  );
}

function StatefulEntityList(props: Omit<ComponentProps<typeof EntityList>, "query" | "onQueryChange">) {
  const [query, setQuery] = useState("");
  return <EntityList {...props} query={query} onQueryChange={setQuery} />;
}

describe("workspace rail and browser", () => {
  it("keeps the icon rail rendered when the browser closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Close browser" }));
    expect(screen.queryByText("LIST:assets")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Geo Features" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "API Keys" })).toBeInTheDocument();
  });

  it("wraps rail actions in Blueprint tooltip targets", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Tracks" }).parentElement).toHaveClass("bp6-popover-target");
  });

  it("switches the browser without disturbing selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Rover One/ }));
    expect(screen.getByRole("button", { name: /Rover One/ })).toHaveAttribute("aria-current", "true");

    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    expect(screen.getByText("list geofeatures")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Geo Features" })).toHaveAttribute("aria-pressed", "true");
  });

  it("restores row focus when the floating inspector closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /Rover One/ }));
    await user.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.getByRole("button", { name: /Rover One/ })).toHaveFocus();
  });

  it("filters entity rows without changing the source list", async () => {
    const user = userEvent.setup();
    render(<StatefulEntityList entities={ASSETS} emptyLabel="none" onSelect={() => {}} />);
    await user.type(screen.getByRole("searchbox", { name: "Filter entities" }), "Two");
    expect(screen.queryByRole("button", { name: /Rover One/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rover Two/ })).toBeInTheDocument();
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("normalizes the filter query and shows the no-match state", async () => {
    const user = userEvent.setup();
    render(<StatefulEntityList entities={ASSETS} emptyLabel="none" onSelect={() => {}} />);
    const filter = screen.getByRole("searchbox", { name: "Filter entities" });
    await user.type(filter, "   ");
    expect(screen.getByText("2 total")).toBeInTheDocument();
    await user.clear(filter);
    await user.type(filter, "missing");
    expect(screen.getByText("0 of 2")).toBeInTheDocument();
    expect(screen.getByText("No matching entities.")).toBeInTheDocument();
  });

  it("does not filter on clock-dependent relative labels", () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-06-20T00:10:00Z");
    const entity: EntityResource = {
      ...ASSETS[0],
      components: {
        communications: { link_state: "connected" },
        heartbeat: { last_seen: "2026-06-20T00:09:58Z" }
      }
    };
    const { unmount } = render(
      <EntityList entities={[entity]} query="just now" emptyLabel="none" onSelect={() => {}} onQueryChange={() => {}} />
    );
    try {
      expect(screen.queryByRole("button", { name: /Rover One/ })).not.toBeInTheDocument();
      expect(screen.getByText("No matching entities.")).toBeInTheDocument();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("focuses the filter when a focused row stops matching", async () => {
    const user = userEvent.setup();
    const props = { query: "Rover One", emptyLabel: "none", onSelect: () => {}, onQueryChange: () => {} };
    const { rerender } = render(<EntityList {...props} entities={ASSETS} />);
    await user.click(screen.getByRole("button", { name: /Rover One/ }));
    const renamed = ASSETS.map((entity) =>
      entity.entity_id === "asset-1" ? { ...entity, alias: "Renamed Rover" } : entity
    );
    rerender(<EntityList {...props} entities={renamed} />);
    expect(screen.getByRole("searchbox", { name: "Filter entities" })).toHaveFocus();
  });

  it("keeps filter focus when a selected row remounts", async () => {
    const user = userEvent.setup();
    render(
      <StatefulEntityList
        entities={ASSETS}
        selectedId="asset-1"
        restoreFocusId="asset-1"
        emptyLabel="none"
        onSelect={() => {}}
      />
    );
    const filter = screen.getByRole("searchbox", { name: "Filter entities" });
    await user.click(filter);
    fireEvent.change(filter, { target: { value: "Two" } });
    fireEvent.change(filter, { target: { value: "" } });
    expect(filter).toHaveFocus();
  });

  it("does not move focus for a map-origin selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const map = screen.getByRole("button", { name: "Map" });
    await user.click(map);
    expect(map).toHaveFocus();
  });

  it("uses the Blueprint input group in the entity browser", () => {
    render(<StatefulEntityList entities={ASSETS} emptyLabel="none" onSelect={() => {}} />);
    expect(screen.getByRole("searchbox")).toHaveClass("bp6-input");
  });
});
