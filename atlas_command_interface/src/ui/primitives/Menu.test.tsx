import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ContextMenu } from "./Menu.js";

function Harness() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setMenuOpen(true)}>
        Open menu
      </button>
      {menuOpen ? (
        <ContextMenu
          x={20}
          y={20}
          items={[
            { key: "send", title: "Send command", onSelect: () => setDialogOpen(true) },
            { key: "inspect", title: "Inspect command" }
          ]}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      {dialogOpen ? (
        <button type="button" autoFocus>
          Dialog action
        </button>
      ) : null}
    </>
  );
}

describe("ContextMenu focus", () => {
  it("focuses its first action and restores the trigger when dismissed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open menu" });

    await user.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Send command" })).toHaveFocus();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("does not steal focus from the next surface after an action", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByRole("button", { name: "Dialog action" })).toHaveFocus());
  });

  it("moves through enabled actions with menu arrow keys", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Inspect command" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Send command" })).toHaveFocus();
  });
});
