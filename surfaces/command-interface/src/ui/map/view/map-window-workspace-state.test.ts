import { describe, expect, it } from "vitest";
import {
  dockTargetAtPoint,
  initialMapWindowWorkspaceState,
  mapWindowWorkspaceReducer
} from "./map-window-workspace-state.js";

describe("map window workspace state", () => {
  it("keeps ordered rails and only one open popout on each edge", () => {
    let state = mapWindowWorkspaceReducer(initialMapWindowWorkspaceState, {
      type: "register",
      id: "scan",
      title: "Building Scan"
    });
    state = mapWindowWorkspaceReducer(state, { type: "register", id: "tasks", title: "Tasks" });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "scan",
      target: { edge: "top", index: 0 }
    });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "tasks",
      target: { edge: "top", index: 0 }
    });

    expect(state.rails.top).toEqual(["tasks", "scan"]);
    expect(state.openByEdge.top).toBe("tasks");

    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "scan",
      target: { edge: "bottom", index: 0 }
    });
    expect(state.rails.top).toEqual(["tasks"]);
    expect(state.rails.bottom).toEqual(["scan"]);
    expect(state.openByEdge).toEqual({ top: "tasks", bottom: "scan" });

    state = mapWindowWorkspaceReducer(state, {
      type: "float",
      id: "tasks",
      position: { left: 120, top: 80 }
    });
    expect(state.rails.top).toEqual([]);
    expect(state.openByEdge.top).toBeUndefined();
    expect(state.windows.tasks).toMatchObject({ placement: "floating", position: { left: 120, top: 80 } });
  });

  it("finds insertion positions on every map edge", () => {
    const bounds = { left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 };
    const lengths = { top: 2, right: 2, bottom: 2, left: 2 };

    expect(dockTargetAtPoint({ x: 500, y: 52 }, bounds, lengths)).toEqual({ edge: "top", index: 1 });
    expect(dockTargetAtPoint({ x: 898, y: 500 }, bounds, lengths)).toEqual({ edge: "right", index: 2 });
    expect(dockTargetAtPoint({ x: 300, y: 648 }, bounds, lengths)).toEqual({ edge: "bottom", index: 1 });
    expect(dockTargetAtPoint({ x: 102, y: 100 }, bounds, lengths)).toEqual({ edge: "left", index: 0 });
    expect(dockTargetAtPoint({ x: 500, y: 300 }, bounds, lengths)).toBeUndefined();
  });

  it("does not pop open a closed tab when it is reordered", () => {
    let state = mapWindowWorkspaceReducer(initialMapWindowWorkspaceState, {
      type: "register",
      id: "scan",
      title: "Building Scan"
    });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "scan",
      target: { edge: "top", index: 0 }
    });
    state = mapWindowWorkspaceReducer(state, { type: "toggle-popout", id: "scan" });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "scan",
      target: { edge: "bottom", index: 0 },
      open: false
    });

    expect(state.rails.bottom).toEqual(["scan"]);
    expect(state.openByEdge).toEqual({});
  });
});
