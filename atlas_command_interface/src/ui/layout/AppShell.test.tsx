import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

function renderShell(collapsed = false) {
  return render(<AppShell collapsed={collapsed} rail={<div>rail</div>} panel={<div>panel</div>} map={<div>map</div>} />);
}

function pointerEvent(type: string, options: { button?: number; clientX?: number } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "button", { value: options.button ?? 0 });
  Object.defineProperty(event, "clientX", { value: options.clientX ?? 0 });
  return event;
}

describe("AppShell", () => {
  it("renders the assets panel at a fixed default width", () => {
    renderShell();
    expect(screen.getByText("rail").parentElement).toHaveStyle("--panel-width: 340px");
    expect(screen.getByRole("separator", { name: "Resize assets panel" })).toHaveAttribute("aria-valuenow", "340");
  });

  it("shrinks the assets panel with keyboard and drag input", async () => {
    renderShell();
    const sidebar = screen.getByText("rail").parentElement;
    const resizer = screen.getByRole("separator", { name: "Resize assets panel" });

    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(sidebar).toHaveStyle("--panel-width: 316px");

    fireEvent(resizer, pointerEvent("pointerdown", { button: 0, clientX: 300 }));
    await waitFor(() => expect(sidebar).toHaveAttribute("data-resizing", "true"));
    window.dispatchEvent(pointerEvent("pointermove", { clientX: 260 }));
    window.dispatchEvent(pointerEvent("pointerup"));
    await waitFor(() => expect(sidebar).toHaveStyle("--panel-width: 280px"));
  });

  it("hides the resizer when the sidebar is collapsed", () => {
    renderShell(true);
    expect(screen.queryByRole("separator", { name: "Resize assets panel" })).not.toBeInTheDocument();
  });
});
