import { describe, expect, it } from "vitest";
import { initialSidebarState, listForKind, type SidebarState, sidebarReducer } from "./selection.js";

describe("workspace selection reducer", () => {
  it("opens and closes the floating browser", () => {
    expect(sidebarReducer(initialSidebarState, { type: "toggleCollapsed" }).collapsed).toBe(true);
    expect(
      sidebarReducer({ ...initialSidebarState, collapsed: true }, { type: "setCollapsed", collapsed: false }).collapsed
    ).toBe(false);
  });

  it("opens a list without changing the selected entity", () => {
    const collapsed: SidebarState = {
      ...initialSidebarState,
      collapsed: true,
      selection: { kind: "asset", id: "asset-1" },
      restoreFocusId: "asset-1"
    };
    const next = sidebarReducer(collapsed, { type: "openList", list: "geofeatures" });
    expect(next.collapsed).toBe(false);
    expect(next.list).toBe("geofeatures");
    expect(next.selection).toEqual({ kind: "asset", id: "asset-1" });
    expect(next.restoreFocusId).toBeNull();
  });

  it("keeps selection separate from the active browser list", () => {
    const onTracks = sidebarReducer(initialSidebarState, { type: "openList", list: "tracks" });
    const selected = sidebarReducer(onTracks, {
      type: "selectEntity",
      kind: "track",
      id: "track-1",
      origin: "sidebar"
    });
    expect(selected.selection).toEqual({ kind: "track", id: "track-1" });
    expect(selected.list).toBe("tracks");
  });

  it("keeps selection single-select", () => {
    let state = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "sidebar"
    });
    state = sidebarReducer(state, { type: "selectEntity", kind: "asset", id: "asset-2", origin: "sidebar" });
    expect(state.selection).toEqual({ kind: "asset", id: "asset-2" });
  });

  it("claims the camera for browser selections and bumps the sequence on re-select", () => {
    const first = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "sidebar"
    });
    expect(first.focusRequest).toEqual({ id: "asset-1", seq: 1 });

    const again = sidebarReducer(first, { type: "selectEntity", kind: "asset", id: "asset-1", origin: "sidebar" });
    expect(again.focusRequest).toEqual({ id: "asset-1", seq: 2 });
  });

  it("does not claim the camera for map selections", () => {
    const fromSidebar = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "sidebar"
    });
    const fromMap = sidebarReducer(fromSidebar, { type: "selectEntity", kind: "asset", id: "asset-2", origin: "map" });
    expect(fromMap.selection).toEqual({ kind: "asset", id: "asset-2" });
    expect(fromMap.focusRequest).toBeNull();
  });

  it("keeps the camera claim sequence monotonic across map selections", () => {
    let state = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "sidebar"
    });
    state = sidebarReducer(state, { type: "selectEntity", kind: "asset", id: "asset-2", origin: "map" });
    state = sidebarReducer(state, { type: "selectEntity", kind: "asset", id: "asset-1", origin: "sidebar" });
    expect(state.focusRequest).toEqual({ id: "asset-1", seq: 2 });
  });

  it("clears selection, releases the camera, and restores browser focus", () => {
    const selected = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "sidebar"
    });
    const cleared = sidebarReducer(selected, { type: "clearSelection" });
    expect(cleared.selection).toBeNull();
    expect(cleared.focusRequest).toBeNull();
    expect(cleared.restoreFocusId).toBe("asset-1");
  });

  it("does not move browser focus after clearing a map selection", () => {
    const selected = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "map"
    });
    const cleared = sidebarReducer(selected, { type: "clearSelection" });
    expect(cleared.restoreFocusId).toBeNull();
  });

  it("maps entity kinds to browser lists", () => {
    expect(listForKind("asset")).toBe("assets");
    expect(listForKind("track")).toBe("tracks");
    expect(listForKind("geofeature")).toBe("geofeatures");
  });
});
