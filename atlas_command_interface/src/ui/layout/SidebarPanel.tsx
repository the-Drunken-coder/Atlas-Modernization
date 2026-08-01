import type { ReactNode } from "react";
import { IconButton } from "../primitives/controls.js";
import { BackIcon, CollapseIcon } from "../primitives/icons.js";

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
        <span className="panel__heading">
          <span className="panel__eyebrow">DIRECTORY / ACTIVE</span>
          <span className="panel__title">{title}</span>
        </span>
        <span style={{ flex: 1 }} />
        <IconButton label="Collapse panel" onClick={onCollapse}>
          <CollapseIcon size={18} />
        </IconButton>
      </div>
      <div className="panel__body">{children}</div>
    </div>
  );
}
