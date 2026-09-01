import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState
} from "react";
import {
  initialMapWindowWorkspaceState,
  type MapWindowDockTarget,
  type MapWindowWorkspaceAction,
  type MapWindowWorkspaceState,
  mapWindowWorkspaceReducer
} from "./map-window-workspace-state.js";

type DragPreview = { id: string; target?: MapWindowDockTarget };

type MapWindowWorkspaceContextValue = {
  state: MapWindowWorkspaceState;
  dispatch(action: MapWindowWorkspaceAction): void;
  workspaceRef: React.RefObject<HTMLDivElement | null>;
  dragPreview?: DragPreview;
  setDragPreview(preview?: DragPreview): void;
};

type DockZoneStyle = CSSProperties & { "--map-window-dock-offset": string };

const MapWindowWorkspaceContext = createContext<MapWindowWorkspaceContextValue | undefined>(undefined);

/** Owns the position, edge attachment, collapse state, and stacking order of every map window. */
export function MapWindowWorkspace({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(mapWindowWorkspaceReducer, initialMapWindowWorkspaceState);
  const [dragPreview, setDragPreview] = useState<DragPreview>();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const value = useMemo(() => ({ state, dispatch, workspaceRef, dragPreview, setDragPreview }), [state, dragPreview]);
  const dockZoneStyle: DockZoneStyle | undefined = dragPreview?.target
    ? { "--map-window-dock-offset": `${dragPreview.target.offset * 100}%` }
    : undefined;

  return (
    <MapWindowWorkspaceContext.Provider value={value}>
      <div ref={workspaceRef} className="map-window-workspace" data-dragging={dragPreview ? true : undefined}>
        {children}
        {dragPreview?.target ? (
          <div
            className="map-window-dock-zone"
            data-edge={dragPreview.target.edge}
            style={dockZoneStyle}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </MapWindowWorkspaceContext.Provider>
  );
}

export function useMapWindowWorkspace(): MapWindowWorkspaceContextValue {
  const workspace = useContext(MapWindowWorkspaceContext);
  if (!workspace) throw new Error("MapWindow must be rendered inside MapWindowWorkspace.");
  return workspace;
}
