import type { ReactNode } from "react";
import { IconButton } from "../primitives/controls.js";
import { CollapseIcon } from "../primitives/icons.js";

type SidebarPanelProps = {
  title: string;
  onCollapse: () => void;
  children: ReactNode;
};

export function SidebarPanel({ title, onCollapse, children }: SidebarPanelProps) {
  return (
    <div className="panel">
      <div className="panel__header">
        <div className="panel__heading">
          <span className="panel__title">{title}</span>
        </div>
        <span style={{ flex: 1 }} />
        <IconButton label="Close browser" onClick={onCollapse}>
          <CollapseIcon size={18} />
        </IconButton>
      </div>
      <div className="panel__body">{children}</div>
    </div>
  );
}
