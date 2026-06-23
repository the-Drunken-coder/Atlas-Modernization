import type { ReactElement } from "react";
import type { EntityKind } from "../../atlas/entities.js";
import type { ListKind } from "../../state/selection.js";
import { AssetsIcon, BrandIcon, CollapseIcon, GeofeaturesIcon, TracksIcon } from "../primitives/icons.js";
import { Tooltip } from "../primitives/Tooltip.js";

type RailItem = {
  list: ListKind;
  label: string;
  Icon: (props: { size?: number }) => ReactElement;
  kind?: EntityKind;
};

const RAIL_ITEMS: RailItem[] = [
  { list: "assets", label: "Assets", Icon: AssetsIcon, kind: "asset" },
  { list: "tracks", label: "Tracks", Icon: TracksIcon, kind: "track" },
  { list: "geofeatures", label: "Geo Features", Icon: GeofeaturesIcon, kind: "geofeature" }
];

type SidebarRailProps = {
  collapsed: boolean;
  activeList: ListKind | null;
  counts: Record<EntityKind, number>;
  onSelectList: (list: ListKind) => void;
  onToggleCollapsed: () => void;
};

export function SidebarRail({ collapsed, activeList, counts, onSelectList, onToggleCollapsed }: SidebarRailProps) {
  return (
    <div className="rail">
      <div className="rail__brand" aria-hidden>
        <BrandIcon size={22} />
      </div>
      {RAIL_ITEMS.map((item) => (
        <Tooltip key={item.list} label={item.label}>
          <button
            type="button"
            className="rail-button"
            aria-label={item.label}
            aria-pressed={activeList === item.list}
            data-active={activeList === item.list}
            onClick={() => onSelectList(item.list)}
          >
            <item.Icon size={20} />
            {item.kind !== undefined && counts[item.kind] > 0 ? <span className="rail-button__badge">{counts[item.kind]}</span> : null}
          </button>
        </Tooltip>
      ))}
      <div className="rail__spacer" />
      <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        <button
          type="button"
          className="rail-button"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          onClick={onToggleCollapsed}
        >
          <CollapseIcon size={20} style={collapsed ? { transform: "scaleX(-1)" } : undefined} />
        </button>
      </Tooltip>
    </div>
  );
}
