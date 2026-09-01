export const MAP_WINDOW_EDGES = ["top", "right", "bottom", "left"] as const;

export type MapWindowEdge = (typeof MAP_WINDOW_EDGES)[number];
export type MapWindowPosition = { left: number; top: number };
export type MapWindowDockTarget = { edge: MapWindowEdge; index: number };

export type MapWindowLayout = {
  id: string;
  title: string;
  placement: "floating" | "docked";
  edge?: MapWindowEdge;
  position?: MapWindowPosition;
  collapsed: boolean;
  cascade: number;
  zIndex: number;
};

export type MapWindowWorkspaceState = {
  windows: Record<string, MapWindowLayout>;
  rails: Record<MapWindowEdge, string[]>;
  openByEdge: Partial<Record<MapWindowEdge, string>>;
  nextZIndex: number;
};

export type MapWindowWorkspaceAction =
  | { type: "register"; id: string; title: string }
  | { type: "unregister"; id: string }
  | { type: "activate"; id: string }
  | { type: "position"; id: string; position: MapWindowPosition }
  | { type: "toggle-collapse"; id: string }
  | { type: "dock"; id: string; target: MapWindowDockTarget; open?: boolean }
  | { type: "float"; id: string; position: MapWindowPosition }
  | { type: "toggle-popout"; id: string }
  | { type: "close-popout"; edge: MapWindowEdge };

export const initialMapWindowWorkspaceState: MapWindowWorkspaceState = {
  windows: {},
  rails: { top: [], right: [], bottom: [], left: [] },
  openByEdge: {},
  nextZIndex: 33
};

export function mapWindowWorkspaceReducer(
  state: MapWindowWorkspaceState,
  action: MapWindowWorkspaceAction
): MapWindowWorkspaceState {
  if (action.type === "register") {
    const current = state.windows[action.id];
    if (current) {
      if (current.title === action.title) return state;
      return {
        ...state,
        windows: { ...state.windows, [action.id]: { ...current, title: action.title } }
      };
    }
    const floatingCount = Object.values(state.windows).filter((window) => window.placement === "floating").length;
    return {
      ...state,
      windows: {
        ...state.windows,
        [action.id]: {
          id: action.id,
          title: action.title,
          placement: "floating",
          collapsed: false,
          cascade: floatingCount % 6,
          zIndex: state.nextZIndex
        }
      },
      nextZIndex: state.nextZIndex + 1
    };
  }

  if (action.type === "unregister") {
    if (!state.windows[action.id]) return state;
    const windows = { ...state.windows };
    delete windows[action.id];
    return {
      ...state,
      windows,
      rails: removeFromRails(state.rails, action.id),
      openByEdge: removeOpenWindow(state.openByEdge, action.id)
    };
  }

  if (action.type === "close-popout") {
    if (!state.openByEdge[action.edge]) return state;
    const openByEdge = { ...state.openByEdge };
    delete openByEdge[action.edge];
    return { ...state, openByEdge };
  }

  const current = state.windows[action.id];
  if (!current) return state;

  if (action.type === "activate") {
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, zIndex: state.nextZIndex } },
      nextZIndex: state.nextZIndex + 1
    };
  }

  if (action.type === "position") {
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, position: action.position } }
    };
  }

  if (action.type === "toggle-collapse") {
    if (current.placement !== "floating") return state;
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, collapsed: !current.collapsed } }
    };
  }

  if (action.type === "dock") {
    const rails = removeFromRails(state.rails, action.id);
    const edgeWindows = [...rails[action.target.edge]];
    edgeWindows.splice(clamp(action.target.index, 0, edgeWindows.length), 0, action.id);
    rails[action.target.edge] = edgeWindows;
    const openByEdge = removeOpenWindow(state.openByEdge, action.id);
    if (action.open !== false) openByEdge[action.target.edge] = action.id;
    return {
      ...state,
      windows: {
        ...state.windows,
        [action.id]: {
          ...current,
          placement: "docked",
          edge: action.target.edge,
          collapsed: false,
          zIndex: state.nextZIndex
        }
      },
      rails,
      openByEdge,
      nextZIndex: state.nextZIndex + 1
    };
  }

  if (action.type === "float") {
    return {
      ...state,
      windows: {
        ...state.windows,
        [action.id]: {
          ...current,
          placement: "floating",
          edge: undefined,
          position: action.position,
          collapsed: false,
          zIndex: state.nextZIndex
        }
      },
      rails: removeFromRails(state.rails, action.id),
      openByEdge: removeOpenWindow(state.openByEdge, action.id),
      nextZIndex: state.nextZIndex + 1
    };
  }

  if (action.type === "toggle-popout") {
    if (current.placement !== "docked" || !current.edge) return state;
    const openByEdge = { ...state.openByEdge };
    if (openByEdge[current.edge] === action.id) delete openByEdge[current.edge];
    else openByEdge[current.edge] = action.id;
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, zIndex: state.nextZIndex } },
      openByEdge,
      nextZIndex: state.nextZIndex + 1
    };
  }

  return state;
}

export function dockTargetAtPoint(
  point: { x: number; y: number },
  bounds: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
  railLengths: Record<MapWindowEdge, number>,
  threshold = 48
): MapWindowDockTarget | undefined {
  const distances: Array<[MapWindowEdge, number]> = [
    ["top", Math.abs(point.y - bounds.top)],
    ["right", Math.abs(bounds.right - point.x)],
    ["bottom", Math.abs(bounds.bottom - point.y)],
    ["left", Math.abs(point.x - bounds.left)]
  ];
  const [edge, distance] = distances.reduce((nearest, candidate) => (candidate[1] < nearest[1] ? candidate : nearest));
  if (
    distance > threshold ||
    point.x < bounds.left - threshold ||
    point.x > bounds.right + threshold ||
    point.y < bounds.top - threshold ||
    point.y > bounds.bottom + threshold
  ) {
    return undefined;
  }

  const horizontal = edge === "top" || edge === "bottom";
  const axisStart = horizontal ? bounds.left : bounds.top;
  const axisLength = horizontal ? bounds.width : bounds.height;
  const axisPoint = horizontal ? point.x : point.y;
  const ratio = axisLength > 0 ? clamp((axisPoint - axisStart) / axisLength, 0, 1) : 0;
  return { edge, index: Math.round(ratio * railLengths[edge]) };
}

export function edgeForArrow(key: string): MapWindowEdge | undefined {
  if (key === "ArrowUp") return "top";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowDown") return "bottom";
  if (key === "ArrowLeft") return "left";
  return undefined;
}

function removeFromRails(rails: Record<MapWindowEdge, string[]>, id: string): Record<MapWindowEdge, string[]> {
  return {
    top: rails.top.filter((candidate) => candidate !== id),
    right: rails.right.filter((candidate) => candidate !== id),
    bottom: rails.bottom.filter((candidate) => candidate !== id),
    left: rails.left.filter((candidate) => candidate !== id)
  };
}

function removeOpenWindow(
  openByEdge: Partial<Record<MapWindowEdge, string>>,
  id: string
): Partial<Record<MapWindowEdge, string>> {
  return Object.fromEntries(Object.entries(openByEdge).filter(([, openId]) => openId !== id));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
