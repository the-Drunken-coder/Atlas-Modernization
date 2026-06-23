import { describe, expect, it } from "vitest";
import { initialSidebarState, listForKind, sidebarReducer, type SidebarState } from "./selection.js";

describe("sidebar reducer", () => {
  it("toggles and sets the collapsed rail", () => {
    expect(sidebarReducer(initialSidebarState, { type: "toggleCollapsed" }).collapsed).toBe(true);
    expect(sidebarReducer({ ...initialSidebarState, collapsed: true }, { type: "setCollapsed", collapsed: false }).collapsed).toBe(false);
  });

  it("opens a list mode and expands the rail", () => {
    const collapsed: SidebarState = { ...initialSidebarState, collapsed: true };
    const next = sidebarReducer(collapsed, { type: "openList", list: "geofeatures" });
    expect(next.collapsed).toBe(false);
    expect(next.view).toEqual({ mode: "list", list: "geofeatures" });
  });

  it("switches to inspector mode when an entity is selected and remembers the list", () => {
    const onTracks = sidebarReducer(initialSidebarState, { type: "openList", list: "tracks" });
    const selected = sidebarReducer(onTracks, { type: "selectEntity", kind: "track", id: "track-1" });
    expect(selected.selection).toEqual({ kind: "track", id: "track-1" });
    expect(selected.view).toEqual({ mode: "inspector", previousList: "tracks" });
  });

  it("keeps selection single-select", () => {
    let state = sidebarReducer(initialSidebarState, { type: "selectEntity", kind: "asset", id: "asset-1" });
    state = sidebarReducer(state, { type: "selectEntity", kind: "asset", id: "asset-2" });
    expect(state.selection).toEqual({ kind: "asset", id: "asset-2" });
  });

  it("returns to the previous list with back and clearSelection", () => {
    const onGeo = sidebarReducer(initialSidebarState, { type: "openList", list: "geofeatures" });
    const selected = sidebarReducer(onGeo, { type: "selectEntity", kind: "geofeature", id: "geo-1" });

    const back = sidebarReducer(selected, { type: "back" });
    expect(back.view).toEqual({ mode: "list", list: "geofeatures" });
    expect(back.selection).toEqual({ kind: "geofeature", id: "geo-1" });

    const cleared = sidebarReducer(selected, { type: "clearSelection" });
    expect(cleared.view).toEqual({ mode: "list", list: "geofeatures" });
    expect(cleared.selection).toBeNull();
  });

  it("maps entity kinds to list kinds", () => {
    expect(listForKind("asset")).toBe("assets");
    expect(listForKind("track")).toBe("tracks");
    expect(listForKind("geofeature")).toBe("geofeatures");
  });
});
