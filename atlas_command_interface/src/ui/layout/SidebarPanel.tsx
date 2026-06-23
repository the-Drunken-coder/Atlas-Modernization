import type { ReactNode } from "react";
import { BackIcon, CollapseIcon } from "../primitives/icons.js";
import { IconButton } from "../primitives/controls.js";

type SidebarPanelProps = {
  title: string;
  onBack?: () => void;
  onCollapse: () => void;
  children: ReactNode;
};

export function SidebarPanel({ title, onBack, onCollapse, children }: SidebarPanelProps) {
  return (
    <div className="panel">
      <div className="panel__header">
        {onBack ? (
          <IconButton label="Back" onClick={onBack}>
            <BackIcon size={18} />
          </IconButton>
        ) : null}
        <span className="panel__title">{title}</span>
        <span style={{ flex: 1 }} />
        <IconButton label="Collapse panel" onClick={onCollapse}>
          <CollapseIcon size={18} />
        </IconButton>
      </div>
      <div className="panel__body">{children}</div>
    </div>
  );
}
