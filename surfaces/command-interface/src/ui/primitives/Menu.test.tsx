import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./Menu.js";

describe("ContextMenu", () => {
  it("owns menu keys, skips disabled items, and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const mapEscape = vi.fn();
    const mapKeyListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") mapEscape();
    };

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open commands
          </button>
          {open ? (
            <ContextMenu
              x={10}
              y={20}
              items={[
                { key: "first", title: "First", onSelect: () => {} },
                { key: "disabled", title: "Disabled", disabled: true },
                { key: "last", title: "Last", onSelect: () => {} }
              ]}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }

    window.addEventListener("keydown", mapKeyListener);
    try {
      render(<Harness />);
      const opener = screen.getByRole("button", { name: "Open commands" });
      await user.click(opener);

      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
      await user.keyboard("{Home}");
      expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
      await user.keyboard("{End}");
      expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
      expect(mapEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", mapKeyListener);
    }
  });

  it("moves focus when the active item becomes disabled", () => {
    const items = [
      { key: "first", title: "First" },
      { key: "last", title: "Last" }
    ];
    const { rerender } = render(<ContextMenu x={10} y={20} items={items} onClose={() => {}} />);

    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    rerender(
      <ContextMenu
        x={10}
        y={20}
        items={[{ key: "first", title: "First", disabled: true }, items[1]]}
        onClose={() => {}}
      />
    );

    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
  });
});
