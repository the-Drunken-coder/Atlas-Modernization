import type { EntityKind } from "../atlas/entities.js";

export type ListKind = "assets" | "tracks" | "geofeatures" | "commands";

export type SidebarView = { mode: "list"; list: ListKind } | { mode: "inspector"; previousList: ListKind };

export type Selection = { kind: EntityKind; id: string } | null;

export type SidebarState = {
  collapsed: boolean;
  view: SidebarView;
  selection: Selection;
};

export type SidebarAction =
  | { type: "toggleCollapsed" }
  | { type: "setCollapsed"; collapsed: boolean }
  | { type: "openList"; list: ListKind }
  | { type: "selectEntity"; kind: EntityKind; id: string }
  | { type: "clearSelection" }
  | { type: "back" };

export const LIST_KINDS: ListKind[] = ["assets", "tracks", "geofeatures", "commands"];

export const initialSidebarState: SidebarState = {
  collapsed: false,
  view: { mode: "list", list: "assets" },
  selection: null
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
      // Opening a list always expands the rail and shows that list.
      return { ...state, collapsed: false, view: { mode: "list", list: action.list } };
    case "selectEntity":
      return {
        ...state,
        collapsed: false,
        selection: { kind: action.kind, id: action.id },
        view: { mode: "inspector", previousList: currentList(state.view) }
      };
    case "clearSelection":
      return {
        ...state,
        selection: null,
        view: state.view.mode === "inspector" ? { mode: "list", list: state.view.previousList } : state.view
      };
    case "back":
      return state.view.mode === "inspector" ? { ...state, view: { mode: "list", list: state.view.previousList } } : state;
    default:
      return state;
  }
}
