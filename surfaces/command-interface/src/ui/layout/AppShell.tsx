import { type CSSProperties, type KeyboardEvent, type ReactNode, useCallback, useEffect, useState } from "react";

type AppShellProps = {
  collapsed: boolean;
  rail: ReactNode;
  panel: ReactNode;
  map: ReactNode;
};

const DEFAULT_PANEL_WIDTH = 300;
const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 520;
const PANEL_WIDTH_STEP = 24;

function clampPanelWidth(width: number): number {
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
}

export function AppShell({ collapsed, rail, panel, map }: AppShellProps) {
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [dragStart, setDragStart] = useState<{ x: number; width: number } | null>(null);
  const shellStyle = { "--panel-width": `${panelWidth}px` } as CSSProperties;

  useEffect(() => {
    if (!dragStart) return;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (event: PointerEvent) => {
      if (!Number.isFinite(event.clientX)) return;
      setPanelWidth(clampPanelWidth(dragStart.width + event.clientX - dragStart.x));
    };
    const onPointerUp = () => setDragStart(null);

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [dragStart]);

  const resizePanel = useCallback((width: number) => setPanelWidth(clampPanelWidth(width)), []);

  const onResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        resizePanel(panelWidth - PANEL_WIDTH_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        resizePanel(panelWidth + PANEL_WIDTH_STEP);
      } else if (event.key === "Home") {
        event.preventDefault();
        resizePanel(MIN_PANEL_WIDTH);
      } else if (event.key === "End") {
        event.preventDefault();
        resizePanel(MAX_PANEL_WIDTH);
      }
    },
    [panelWidth, resizePanel]
  );

  return (
    <div className="app-shell">
      <div
        className="sidebar"
        data-collapsed={collapsed}
        data-resizing={dragStart ? true : undefined}
        style={shellStyle}
      >
        {rail}
        {panel}
        {collapsed ? null : (
          <div
            aria-label="Resize sidebar panel"
            aria-orientation="vertical"
            aria-valuemax={MAX_PANEL_WIDTH}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuenow={panelWidth}
            className="sidebar-resizer"
            onKeyDown={onResizeKeyDown}
            onPointerDown={(event) => {
              if (event.button > 0) return;
              if (!Number.isFinite(event.clientX)) return;
              event.preventDefault();
              setDragStart({ x: event.clientX, width: panelWidth });
            }}
            role="separator"
            tabIndex={0}
          />
        )}
      </div>
      <main className="map-region" aria-label="Map workspace">
        {map}
      </main>
    </div>
  );
}
