import type { ReactNode } from "react";

type AppShellProps = {
  collapsed: boolean;
  rail: ReactNode;
  panel: ReactNode;
  map: ReactNode;
};

export function AppShell({ collapsed, rail, panel, map }: AppShellProps) {
  return (
    <div className="app-shell">
      <div className="sidebar" data-collapsed={collapsed}>
        {rail}
        {panel}
      </div>
      <div className="map-region">{map}</div>
    </div>
  );
}
