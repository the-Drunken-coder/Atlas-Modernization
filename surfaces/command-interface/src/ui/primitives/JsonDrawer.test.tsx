import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonDrawer } from "./JsonDrawer.js";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("JsonDrawer", () => {
  it("only reports copied after a clipboard write succeeds", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<JsonDrawer defaultOpen value={{ id: "asset-1" }} />);

    await user.click(screen.getByRole("button", { name: "Copy JSON" }));

    expect(writeText).toHaveBeenCalledWith('{\n  "id": "asset-1"\n}');
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("clears the copied reset timer when unmounted", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const { unmount } = render(<JsonDrawer defaultOpen value={{ id: "asset-1" }} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy JSON" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Copied")).toBeInTheDocument();

    unmount();
    vi.advanceTimersByTime(1200);

    expect(consoleError).not.toHaveBeenCalled();
  });
});
