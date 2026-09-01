export const MAP_WINDOW_EDGES = ["top", "right", "bottom", "left"] as const;

export type MapWindowEdge = (typeof MAP_WINDOW_EDGES)[number];
export type MapWindowPosition = { left: number; top: number };
export type MapWindowDockTarget = { edge: MapWindowEdge; offset: number };

export type MapWindowLayout = {
  id: string;
  title: string;
  placement: "floating" | "docked";
  edge?: MapWindowEdge;
  dockOffset?: number;
  position?: MapWindowPosition;
  collapsed: boolean;
  cascade: number;
  zIndex: number;
};

export type MapWindowWorkspaceState = {
  windows: Record<string, MapWindowLayout>;
  nextZIndex: number;
};

export type MapWindowWorkspaceAction =
  | { type: "register"; id: string; title: string }
  | { type: "unregister"; id: string }
  | { type: "activate"; id: string }
  | { type: "position"; id: string; position: MapWindowPosition }
  | { type: "dock-position"; id: string; offset: number }
  | { type: "toggle-collapse"; id: string }
  | { type: "dock"; id: string; target: MapWindowDockTarget; collapsed?: boolean }
  | { type: "float"; id: string; position: MapWindowPosition };

export const initialMapWindowWorkspaceState: MapWindowWorkspaceState = {
  windows: {},
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
    return {
      ...state,
      windows: {
        ...state.windows,
        [action.id]: {
          id: action.id,
          title: action.title,
          placement: "floating",
          collapsed: false,
          cascade: firstAvailableCascade(state.windows),
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
    return { ...state, windows };
  }

  const current = state.windows[action.id];
  if (!current) return state;

  if (action.type === "activate") {
    if (current.zIndex === state.nextZIndex - 1) return state;
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, zIndex: state.nextZIndex } },
      nextZIndex: state.nextZIndex + 1
    };
  }

  if (action.type === "position") {
    if (current.placement !== "floating") return state;
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, position: action.position } }
    };
  }

  if (action.type === "dock-position") {
    if (current.placement !== "docked") return state;
    const dockOffset = clamp(action.offset, 0, 1);
    if (dockOffset === current.dockOffset) return state;
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, dockOffset } }
    };
  }

  if (action.type === "toggle-collapse") {
    return {
      ...state,
      windows: { ...state.windows, [action.id]: { ...current, collapsed: !current.collapsed } }
    };
  }

  if (action.type === "dock") {
    return {
      ...state,
      windows: {
        ...state.windows,
        [action.id]: {
          ...current,
          placement: "docked",
          edge: action.target.edge,
          dockOffset: clamp(action.target.offset, 0, 1),
          collapsed: action.collapsed ?? false,
          zIndex: state.nextZIndex
        }
      },
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
          dockOffset: undefined,
          position: action.position,
          collapsed: false,
          zIndex: state.nextZIndex
        }
      },
      nextZIndex: state.nextZIndex + 1
    };
  }

  return state;
}

export function dockTargetAtPoint(
  point: { x: number; y: number },
  bounds: Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">,
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
  return { edge, offset: ratio };
}

export function edgeForArrow(key: string): MapWindowEdge | undefined {
  if (key === "ArrowUp") return "top";
  if (key === "ArrowRight") return "right";
  if (key === "ArrowDown") return "bottom";
  if (key === "ArrowLeft") return "left";
  return undefined;
}

function firstAvailableCascade(windows: Record<string, MapWindowLayout>): number {
  const used = new Set(
    Object.values(windows)
      .filter((window) => window.placement === "floating" && !window.position)
      .map((window) => window.cascade)
  );
  for (let cascade = 0; cascade < 6; cascade += 1) {
    if (!used.has(cascade)) return cascade;
  }
  return 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
