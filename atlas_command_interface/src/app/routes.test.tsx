import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConsoleRoutes } from "./routes.js";

describe("console routes", () => {
  it("redirects /home to /map", () => {
    const replacePath = vi.fn();
    render(<ConsoleRoutes mapElement={<div>MAP WORKSPACE</div>} pathname="/home" replacePath={replacePath} />);

    expect(screen.getByText("MAP WORKSPACE")).toBeInTheDocument();
    expect(replacePath).toHaveBeenCalledWith("/map");
  });

  it("redirects unknown paths to /map", () => {
    const replacePath = vi.fn();
    render(
      <ConsoleRoutes mapElement={<div>MAP WORKSPACE</div>} pathname="/somewhere-else" replacePath={replacePath} />
    );

    expect(screen.getByText("MAP WORKSPACE")).toBeInTheDocument();
    expect(replacePath).toHaveBeenCalledWith("/map");
  });

  it("renders the map workspace at /map without replacing history", () => {
    const replacePath = vi.fn();
    render(<ConsoleRoutes mapElement={<div>MAP WORKSPACE</div>} pathname="/map" replacePath={replacePath} />);

    expect(screen.getByText("MAP WORKSPACE")).toBeInTheDocument();
    expect(replacePath).not.toHaveBeenCalled();
  });
});
