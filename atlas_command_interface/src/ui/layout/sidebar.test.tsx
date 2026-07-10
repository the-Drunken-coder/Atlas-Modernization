import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { EntityList } from "../../features/EntityList.js";
import { initialSidebarState, listForKind, sidebarReducer } from "../../state/selection.js";
import { SidebarPanel } from "./SidebarPanel.js";
import { SidebarRail } from "./SidebarRail.js";

const metadata = { created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z", version: 1 };

const ASSETS: EntityResource[] = [
  { entity_id: "asset-1", entity_type: "asset", subtype: null, alias: "Rover One", components: {}, metadata },
  { entity_id: "asset-2", entity_type: "asset", subtype: null, alias: "Rover Two", components: {}, metadata }
];

function Harness() {
  const [state, dispatch] = useReducer(sidebarReducer, initialSidebarState);
  const activeList = state.view.mode === "list" ? state.view.list : state.selection ? listForKind(state.selection.kind) : null;

  return (
    <div className="sidebar" data-collapsed={state.collapsed} data-testid="sidebar">
      <SidebarRail
        collapsed={state.collapsed}
        activeList={activeList}
        counts={{ asset: ASSETS.length, track: 0, geofeature: 0 }}
        onSelectList={(list) => dispatch({ type: "openList", list })}
        onToggleCollapsed={() => dispatch({ type: "toggleCollapsed" })}
      />
      <SidebarPanel
        title={state.view.mode === "list" ? `LIST:${state.view.list}` : `INSPECTOR:${state.selection?.id}`}
        onBack={state.view.mode === "inspector" ? () => dispatch({ type: "back" }) : undefined}
        onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
      >
        {state.view.mode === "list" && state.view.list === "assets" ? (
          <EntityList
            entities={ASSETS}
            selectedId={state.selection?.id}
            emptyLabel="none"
            onSelect={(entity) => dispatch({ type: "selectEntity", kind: "asset", id: entity.entity_id, origin: "sidebar" })}
          />
        ) : (
          <div>{state.view.mode === "inspector" ? `inspector ${state.selection?.id}` : `list ${state.view.list}`}</div>
        )}
      </SidebarPanel>
    </div>
  );
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

    // Back returns to the previous list.
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Rover One")).toBeInTheDocument();
  });

  it("does not repeat preview callbacks on row pointer movement", () => {
    const onPreview = vi.fn();
    render(<EntityList entities={ASSETS} selectedId={undefined} emptyLabel="none" onSelect={() => {}} onPreview={onPreview} />);

    const row = screen.getByRole("button", { name: /Rover One/ });
    fireEvent.pointerEnter(row);
    fireEvent.pointerMove(row);
    fireEvent.pointerMove(row);

    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(ASSETS[0]);
  });
});
