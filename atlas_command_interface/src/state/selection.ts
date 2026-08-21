import type { EntityKind } from "../atlas/entities.js";

export type ListKind = "assets" | "tracks" | "geofeatures" | "commands" | "apiKeys";

export type SidebarView = { mode: "list"; list: ListKind } | { mode: "inspector"; previousList: ListKind };

export type Selection = { kind: EntityKind; id: string } | null;

/** Where a selection came from. Only sidebar selections claim the camera. */
export type SelectionOrigin = "sidebar" | "map";

/**
 * A camera claim on the selected entity. `seq` is bumped on every sidebar
 * selection so re-selecting the same entity re-flies the camera.
 */
export type FocusRequest = { id: string; seq: number };

export type SidebarState = {
  collapsed: boolean;
  view: SidebarView;
  selection: Selection;
  focusRequest: FocusRequest | null;
  restoreFocusId: string | null;
  // Monotonic camera-claim counter. Never reset, even when focusRequest
  // clears, so a later claim always carries a higher seq than any prior one.
  focusSeq: number;
};

export type SidebarAction =
  | { type: "toggleCollapsed" }
  | { type: "setCollapsed"; collapsed: boolean }
  | { type: "openList"; list: ListKind }
  | { type: "selectEntity"; kind: EntityKind; id: string; origin: SelectionOrigin }
  | { type: "clearSelection" }
  | { type: "back" };

export const initialSidebarState: SidebarState = {
  collapsed: false,
  view: { mode: "list", list: "assets" },
  selection: null,
  focusRequest: null,
  restoreFocusId: null,
  focusSeq: 0
};

export function listForKind(kind: EntityKind): ListKind {
  return kind === "asset" ? "assets" : kind === "track" ? "tracks" : "geofeatures";
}

function currentList(view: SidebarView): ListKind {
  return view.mode === "list" ? view.list : view.previousList;
}

export function sidebarReducer(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action.type) {
    case "toggleCollapsed":
      return { ...state, collapsed: !state.collapsed };
    case "setCollapsed":
      return { ...state, collapsed: action.collapsed };
    case "openList":
      return { ...state, collapsed: false, restoreFocusId: null, view: { mode: "list", list: action.list } };
    case "selectEntity": {
      // Sidebar selections drive the camera; map selections leave it alone
      // (and release any earlier claim so follow stops).
      const fromSidebar = action.origin === "sidebar";
      return {
        ...state,
        collapsed: false,
        selection: { kind: action.kind, id: action.id },
        focusRequest: fromSidebar ? { id: action.id, seq: state.focusSeq + 1 } : null,
        restoreFocusId: null,
        focusSeq: fromSidebar ? state.focusSeq + 1 : state.focusSeq,
        view: { mode: "inspector", previousList: currentList(state.view) }
      };
    }
    case "clearSelection":
      return {
        ...state,
        selection: null,
        focusRequest: null,
        restoreFocusId: null,
        view: state.view.mode === "inspector" ? { mode: "list", list: state.view.previousList } : state.view
      };
    case "back":
      return state.view.mode === "inspector"
        ? {
            ...state,
            restoreFocusId: state.focusRequest?.id ?? null,
            view: { mode: "list", list: state.view.previousList }
          }
        : state;
    default:
      return state;
  }
}
