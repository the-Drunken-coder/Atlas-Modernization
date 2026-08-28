import { Button } from "@blueprintjs/core";
import type { ReactElement } from "react";
import { ENTITY_DESCRIPTORS, type EntityKind } from "../../atlas/entities.js";
import type { ListKind } from "../../state/selection.js";
import {
  AssetsIcon,
  CollapseIcon,
  CommandsIcon,
  GeofeaturesIcon,
  KeyIcon,
  SearchIcon,
  TracksIcon
} from "../primitives/icons.js";
import { Tooltip } from "../primitives/Tooltip.js";

type RailItem = {
  list: ListKind;
  label: string;
  Icon: (props: { size?: number }) => ReactElement;
  kind?: EntityKind;
};

const PRIMARY_RAIL_ITEMS: RailItem[] = [
  { ...ENTITY_DESCRIPTORS.asset, Icon: AssetsIcon, kind: "asset" },
  { ...ENTITY_DESCRIPTORS.track, Icon: TracksIcon, kind: "track" },
  { ...ENTITY_DESCRIPTORS.geofeature, Icon: GeofeaturesIcon, kind: "geofeature" },
  { list: "places", label: "Places", Icon: SearchIcon },
  { list: "commands", label: "Commands", Icon: CommandsIcon }
];

const ADMIN_RAIL_ITEMS: RailItem[] = [{ list: "apiKeys", label: "API Keys", Icon: KeyIcon }];

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
      <div className="rail__brand-placeholder" aria-hidden />
      {PRIMARY_RAIL_ITEMS.map((item) => (
        <RailButton
          key={item.list}
          item={item}
          active={activeList === item.list}
          count={item.kind === undefined ? 0 : counts[item.kind]}
          onSelect={onSelectList}
        />
      ))}
      <div className="rail__spacer" />
      {ADMIN_RAIL_ITEMS.map((item) => (
        <RailButton key={item.list} item={item} active={activeList === item.list} count={0} onSelect={onSelectList} />
      ))}
      <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        <Button
          type="button"
          className="rail-button"
          minimal
          icon={<CollapseIcon size={20} style={collapsed ? { transform: "scaleX(-1)" } : undefined} />}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          onClick={onToggleCollapsed}
        />
      </Tooltip>
    </div>
  );
}

function RailButton({
  item,
  active,
  count,
  onSelect
}: {
  item: RailItem;
  active: boolean;
  count: number;
  onSelect: (list: ListKind) => void;
}) {
  return (
    <Tooltip label={item.label}>
      <Button
        type="button"
        className="rail-button"
        minimal
        active={active}
        icon={<item.Icon size={20} />}
        aria-label={item.label}
        aria-pressed={active}
        data-active={active}
        onClick={() => onSelect(item.list)}
      >
        {count > 0 ? <span className="rail-button__badge">{count}</span> : null}
      </Button>
    </Tooltip>
  );
}
