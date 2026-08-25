import { Button, Tag, Tooltip } from "@blueprintjs/core";
import type { ReactElement } from "react";
import { ENTITY_DESCRIPTORS, type EntityKind } from "../../atlas/entities.js";
import type { ListKind } from "../../state/selection.js";
import { AssetsIcon, CollapseIcon, GeofeaturesIcon, KeyIcon, TracksIcon } from "../primitives/icons.js";

type RailItem = {
  list: ListKind;
  label: string;
  Icon: (props: { size?: number }) => ReactElement;
  kind?: EntityKind;
};

const PRIMARY_RAIL_ITEMS: RailItem[] = [
  { ...ENTITY_DESCRIPTORS.asset, Icon: AssetsIcon, kind: "asset" },
  { ...ENTITY_DESCRIPTORS.track, Icon: TracksIcon, kind: "track" },
  { ...ENTITY_DESCRIPTORS.geofeature, Icon: GeofeaturesIcon, kind: "geofeature" }
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
      <Tooltip content={collapsed ? "Open browser" : "Hide browser"} placement="right">
        <Button
          type="button"
          variant="minimal"
          className="rail-button"
          aria-label="Toggle browser"
          aria-pressed={collapsed}
          onClick={onToggleCollapsed}
        >
          <CollapseIcon size={20} style={collapsed ? { transform: "scaleX(-1)" } : undefined} />
        </Button>
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
    <Tooltip content={item.label} placement="right">
      <Button
        type="button"
        variant="minimal"
        className="rail-button"
        aria-label={item.label}
        aria-pressed={active}
        data-active={active}
        onClick={() => onSelect(item.list)}
      >
        <item.Icon size={20} />
        {count > 0 ? (
          <Tag className="rail-button__badge" minimal>
            {count}
          </Tag>
        ) : null}
      </Button>
    </Tooltip>
  );
}
