import { describe, expect, it } from "vitest";
import { initialSidebarState, listForKind, type SidebarState, sidebarReducer } from "./selection.js";

describe("sidebar reducer", () => {
  it("toggles and sets the collapsed rail", () => {
    expect(sidebarReducer(initialSidebarState, { type: "toggleCollapsed" }).collapsed).toBe(true);
    expect(
      sidebarReducer({ ...initialSidebarState, collapsed: true }, { type: "setCollapsed", collapsed: false }).collapsed
    ).toBe(false);
  });

  it("opens a list mode and expands the rail", () => {
    const collapsed: SidebarState = { ...initialSidebarState, collapsed: true, restoreFocusId: "asset-1" };
    const next = sidebarReducer(collapsed, { type: "openList", list: "geofeatures" });
    expect(next.collapsed).toBe(false);
    expect(next.view).toEqual({ mode: "list", list: "geofeatures" });
    expect(next.restoreFocusId).toBeNull();
  });

  it("opens the Places workspace as a normal list", () => {
    const next = sidebarReducer(initialSidebarState, { type: "openList", list: "places" });

    expect(next.view).toEqual({ mode: "list", list: "places" });
    expect(next.selection).toBeNull();
  });

  it("switches to inspector mode when an entity is selected and remembers the list", () => {
    const onTracks = sidebarReducer(initialSidebarState, { type: "openList", list: "tracks" });
    const selected = sidebarReducer(onTracks, {
      type: "selectEntity",
      kind: "track",
      id: "track-1",
      origin: "sidebar"
    });
    expect(selected.selection).toEqual({ kind: "track", id: "track-1" });
    expect(selected.view).toEqual({ mode: "inspector", previousList: "tracks" });
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

  it("claims the camera for sidebar selections and bumps the sequence on re-select", () => {
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

  it("keeps the claim sequence monotonic across map selections and clears", () => {
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

  it("releases the camera claim when the selection clears", () => {
    const selected = sidebarReducer(initialSidebarState, {
      type: "selectEntity",
      kind: "asset",
      id: "asset-1",
      origin: "sidebar"
    });
    expect(sidebarReducer(selected, { type: "clearSelection" }).focusRequest).toBeNull();
  });

  it("returns to the previous list with back and clearSelection", () => {
    const onGeo = sidebarReducer(initialSidebarState, { type: "openList", list: "geofeatures" });
    const selected = sidebarReducer(onGeo, {
      type: "selectEntity",
      kind: "geofeature",
      id: "geo-1",
      origin: "sidebar"
    });

    const back = sidebarReducer(selected, { type: "back" });
    expect(back.view).toEqual({ mode: "list", list: "geofeatures" });
    expect(back.selection).toEqual({ kind: "geofeature", id: "geo-1" });
    expect(back.restoreFocusId).toBe("geo-1");

    const cleared = sidebarReducer(selected, { type: "clearSelection" });
    expect(cleared.view).toEqual({ mode: "list", list: "geofeatures" });
    expect(cleared.selection).toBeNull();
    expect(cleared.restoreFocusId).toBeNull();
  });

  it("maps entity kinds to list kinds", () => {
    expect(listForKind("asset")).toBe("assets");
    expect(listForKind("track")).toBe("tracks");
    expect(listForKind("geofeature")).toBe("geofeatures");
  });
});
