import type { ReactNode } from "react";

type AppShellProps = {
  collapsed: boolean;
  rail: ReactNode;
  panel: ReactNode;
  map: ReactNode;
};

/** Map-first application frame. Browser panels layer over the map instead of resizing it. */
export function AppShell({ collapsed, rail, panel, map }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="rail-shell">{rail}</aside>
      <main className="map-region" aria-label="Map workspace">
        {map}
        {collapsed ? null : <aside className="workspace-panel-overlay">{panel}</aside>}
      </main>
    </div>
  );
}
