import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

function renderShell(collapsed = false) {
  return render(
    <AppShell collapsed={collapsed} rail={<div>rail</div>} panel={<div>panel</div>} map={<div>map</div>} />
  );
}

describe("AppShell", () => {
  it("layers the browser panel inside the map workspace", () => {
    renderShell();
    const map = screen.getByRole("main", { name: "Map workspace" });
    expect(map).toContainElement(screen.getByText("map"));
    expect(map).toContainElement(screen.getByText("panel"));
    expect(map).not.toContainElement(screen.getByText("rail"));
  });

  it("hides only the browser surface when collapsed", () => {
    renderShell(true);
    expect(screen.queryByText("panel")).not.toBeInTheDocument();
    expect(screen.getByText("rail")).toBeInTheDocument();
    expect(screen.getByText("map")).toBeInTheDocument();
  });

  it("keeps the map workspace mounted when the browser closes", () => {
    const { rerender } = renderShell();
    const map = screen.getByRole("main", { name: "Map workspace" });

    rerender(<AppShell collapsed rail={<div>rail</div>} panel={<div>panel</div>} map={<div>map</div>} />);

    expect(screen.getByRole("main", { name: "Map workspace" })).toBe(map);
    expect(map).toHaveTextContent("map");
  });
});
