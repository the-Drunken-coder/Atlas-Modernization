import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { type ComponentProps, useReducer, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { EntityList } from "../../features/EntityList.js";
import { initialSidebarState, listForKind, sidebarReducer } from "../../state/selection.js";
import { SidebarPanel } from "./SidebarPanel.js";
import { SidebarRail } from "./SidebarRail.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

const ASSETS: EntityResource[] = [
  { entity_id: "asset-1", entity_type: "asset", subtype: null, alias: "Rover One", components: {}, metadata },
  { entity_id: "asset-2", entity_type: "asset", subtype: null, alias: "Rover Two", components: {}, metadata }
];

function Harness({
  entities = ASSETS,
  initialQuery = ""
}: {
  entities?: EntityResource[];
  initialQuery?: string;
} = {}) {
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const [query, setQuery] = useState(initialQuery);
  const activeList =
    state.view.mode === "list" ? state.view.list : state.selection ? listForKind(state.selection.kind) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => dispatch({ type: "selectEntity", kind: "asset", id: "asset-1", origin: "map" })}
      >
        Map
      </button>
      <div className="sidebar" data-collapsed={state.collapsed} data-testid="sidebar">
        <SidebarRail
          collapsed={state.collapsed}
          activeList={activeList}
          counts={{ asset: entities.length, track: 0, geofeature: 0 }}
          onSelectList={(list) => dispatch({ type: "openList", list })}
          onToggleCollapsed={() => dispatch({ type: "toggleCollapsed" })}
        />
        <SidebarPanel
          title={state.view.mode === "list" ? `LIST:${state.view.list}` : `INSPECTOR:${state.selection?.id}`}
          onBack={state.view.mode === "inspector" ? () => dispatch({ type: "back" }) : undefined}
          autoFocusBack={state.focusRequest?.id === state.selection?.id}
          onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
        >
          {state.view.mode === "list" && state.view.list === "assets" ? (
            <EntityList
              entities={entities}
              selectedId={state.selection?.id}
              restoreFocusId={state.focusRequest?.id}
              query={query}
              emptyLabel="none"
              onSelect={(entity) =>
                dispatch({ type: "selectEntity", kind: "asset", id: entity.entity_id, origin: "sidebar" })
              }
              onQueryChange={setQuery}
            />
          ) : (
            <div>
              {state.view.mode === "inspector" ? `inspector ${state.selection?.id}` : `list ${state.view.list}`}
            </div>
          )}
        </SidebarPanel>
      </div>
    </>
  );
}

function StatefulEntityList(props: Omit<ComponentProps<typeof EntityList>, "query" | "onQueryChange">) {
  const [query, setQuery] = useState("");
  return <EntityList {...props} query={query} onQueryChange={setQuery} />;
}

describe("sidebar rail + panel", () => {
  it("keeps the icon rail rendered when collapsed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Collapse panel" }));
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    // The rail icon buttons remain in the DOM.
    expect(screen.getByRole("button", { name: "Assets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Geo Features" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "API Keys" })).toBeInTheDocument();
  });

  it("shows a tooltip when an icon is focused", async () => {
    render(<Harness />);
    screen.getByRole("button", { name: "Tracks" }).focus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Tracks");
  });

  it("opens a list mode when a rail icon is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Assets" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Geo Features" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: "Geo Features" }));
    expect(screen.getByText("list geofeatures")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assets" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Geo Features" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "API Keys" }));
    expect(screen.getByText("list apiKeys")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "API Keys" })).toHaveAttribute("aria-pressed", "true");
  });

  it("switches to inspector mode when a list item is selected", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Rover One"));
    expect(screen.getByText("inspector asset-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toHaveFocus();

    // Back returns to the previous list.
    await user.click(screen.getByRole("button", { name: "Back" }));
    const selectedRow = screen.getByRole("button", { name: /Rover One/ });
    expect(selectedRow).toHaveFocus();
    expect(selectedRow).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /Rover Two/ })).not.toHaveAttribute("aria-current");
  });

  it("does not repeat preview callbacks on row pointer movement", () => {
    const onPreview = vi.fn();
    render(
      <StatefulEntityList
        entities={ASSETS}
        selectedId={undefined}
        emptyLabel="none"
        onSelect={() => {}}
        onPreview={onPreview}
      />
    );

    const row = screen.getByRole("button", { name: /Rover One/ });
    fireEvent.pointerEnter(row);
    fireEvent.pointerMove(row);
    fireEvent.pointerMove(row);

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(ASSETS[0]);
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

  it("focuses the filter when the selected row no longer matches on Back", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness initialQuery="Rover One" />);

    await user.click(screen.getByRole("button", { name: /Rover One/ }));
    const renamed = ASSETS.map((entity) =>
      entity.entity_id === "asset-1" ? { ...entity, alias: "Renamed Rover" } : entity
    );
    rerender(<Harness entities={renamed} initialQuery="Rover One" />);
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("searchbox", { name: "Filter entities" })).toHaveFocus();
  });

  it("focuses the filter when a focused row stops matching", async () => {
    const user = userEvent.setup();
    const props = {
      query: "Rover One",
      emptyLabel: "none",
      onSelect: () => {},
      onQueryChange: () => {}
    };
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
    expect(screen.getByRole("button", { name: "Back" })).not.toHaveFocus();
  });
});
