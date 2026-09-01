import { describe, expect, it } from "vitest";
import {
  dockTargetAtPoint,
  initialMapWindowWorkspaceState,
  mapWindowWorkspaceReducer
} from "./map-window-workspace-state.js";

describe("map window workspace state", () => {
  it("keeps independent continuous positions for windows attached to the same edge", () => {
    let state = mapWindowWorkspaceReducer(initialMapWindowWorkspaceState, {
      type: "register",
      id: "scan",
      title: "Building Scan"
    });
    state = mapWindowWorkspaceReducer(state, { type: "register", id: "tasks", title: "Tasks" });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "scan",
      target: { edge: "top", offset: 0.2 }
    });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "tasks",
      target: { edge: "top", offset: 0.8 }
    });

    expect(state.windows.scan).toMatchObject({ placement: "docked", edge: "top", dockOffset: 0.2 });
    expect(state.windows.tasks).toMatchObject({ placement: "docked", edge: "top", dockOffset: 0.8 });

    state = mapWindowWorkspaceReducer(state, { type: "dock-position", id: "scan", offset: 0.63 });
    state = mapWindowWorkspaceReducer(state, { type: "toggle-collapse", id: "scan" });
    expect(state.windows.scan).toMatchObject({ dockOffset: 0.63, collapsed: true });

    state = mapWindowWorkspaceReducer(state, {
      type: "float",
      id: "tasks",
      position: { left: 120, top: 80 }
    });
    expect(state.windows.tasks).toMatchObject({
      placement: "floating",
      edge: undefined,
      dockOffset: undefined,
      position: { left: 120, top: 80 }
    });
  });

  it("finds continuous positions on every map edge", () => {
    const bounds = { left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 };

    expect(dockTargetAtPoint({ x: 500, y: 52 }, bounds)).toEqual({ edge: "top", offset: 0.5 });
    expect(dockTargetAtPoint({ x: 898, y: 500 }, bounds)).toEqual({ edge: "right", offset: 0.75 });
    expect(dockTargetAtPoint({ x: 300, y: 648 }, bounds)).toEqual({ edge: "bottom", offset: 0.25 });
    expect(dockTargetAtPoint({ x: 102, y: 100 }, bounds)).toEqual({
      edge: "left",
      offset: 1 / 12
    });
    expect(dockTargetAtPoint({ x: 500, y: 300 }, bounds)).toBeUndefined();
  });

  it("clamps stored edge positions to the normalized range", () => {
    let state = mapWindowWorkspaceReducer(initialMapWindowWorkspaceState, {
      type: "register",
      id: "scan",
      title: "Building Scan"
    });
    state = mapWindowWorkspaceReducer(state, {
      type: "dock",
      id: "scan",
      target: { edge: "right", offset: 2 }
    });
    expect(state.windows.scan?.dockOffset).toBe(1);

    state = mapWindowWorkspaceReducer(state, { type: "dock-position", id: "scan", offset: -1 });
    expect(state.windows.scan?.dockOffset).toBe(0);
  });

  it("reuses the first free cascade slot without covering an existing window", () => {
    let state = initialMapWindowWorkspaceState;
    for (const id of ["first", "second", "third"]) {
      state = mapWindowWorkspaceReducer(state, { type: "register", id, title: id });
    }
    state = mapWindowWorkspaceReducer(state, { type: "unregister", id: "second" });
    state = mapWindowWorkspaceReducer(state, { type: "register", id: "fourth", title: "fourth" });

    expect(state.windows.first?.cascade).toBe(0);
    expect(state.windows.third?.cascade).toBe(2);
    expect(state.windows.fourth?.cascade).toBe(1);

    const unchanged = mapWindowWorkspaceReducer(state, { type: "activate", id: "fourth" });
    expect(unchanged).toBe(state);
  });
});
