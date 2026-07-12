import { useEffect, useRef, useState, type ReactElement } from "react";
import type { EntityKind } from "../../atlas/entities.js";
import { useAuthenticatedSession } from "../../auth/session-context.js";
import type { ListKind } from "../../state/selection.js";
import { AssetsIcon, BrandIcon, CollapseIcon, CommandsIcon, GeofeaturesIcon, KeyIcon, TracksIcon } from "../primitives/icons.js";
import { Tooltip } from "../primitives/Tooltip.js";

type RailItem = {
  list: ListKind;
  label: string;
  Icon: (props: { size?: number }) => ReactElement;
  kind?: EntityKind;
};

const PRIMARY_RAIL_ITEMS: RailItem[] = [
	{ list: "assets", label: "Assets", Icon: AssetsIcon, kind: "asset" },
	{ list: "tracks", label: "Tracks", Icon: TracksIcon, kind: "track" },
	{ list: "geofeatures", label: "Geo Features", Icon: GeofeaturesIcon, kind: "geofeature" },
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
			<AccountMenu />
			{PRIMARY_RAIL_ITEMS.map((item) => (
				<RailButton key={item.list} item={item} active={activeList === item.list} count={item.kind === undefined ? 0 : counts[item.kind]} onSelect={onSelectList} />
			))}
			<div className="rail__spacer" />
			{ADMIN_RAIL_ITEMS.map((item) => (
				<RailButton key={item.list} item={item} active={activeList === item.list} count={0} onSelect={onSelectList} />
			))}
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

function AccountMenu() {
	const session = useAuthenticatedSession();
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const closeOnOutsideClick = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeOnEscape = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsideClick);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsideClick);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	if (!session) {
		return (
			<div className="rail__brand" aria-hidden>
				<BrandIcon size={22} />
			</div>
		);
	}

	return (
		<div className="account-menu" ref={containerRef}>
			<button
				type="button"
				className="rail__brand rail__brand-button"
				aria-label="Account"
				aria-expanded={open}
				aria-haspopup="menu"
				title="Account"
				onClick={() => setOpen((current) => !current)}
			>
				<BrandIcon size={22} />
			</button>
			{open ? (
				<div className="account-menu__popover" role="menu" aria-label="Account menu">
					<div className="account-menu__identity">
						<span>Your account</span>
						<strong>{session.username}</strong>
					</div>
					<button type="button" className="account-menu__item" role="menuitem" disabled>
						<span>Settings</span>
						<small>Coming soon</small>
					</button>
					<button
						type="button"
						className="account-menu__item account-menu__item--danger"
						role="menuitem"
						disabled={session.loggingOut}
						onClick={() => void session.logout()}
					>
						{session.loggingOut ? "Logging out..." : "Log out"}
					</button>
					{session.error ? (
						<span className="account-menu__error" role="alert">
							{session.error}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function RailButton({ item, active, count, onSelect }: { item: RailItem; active: boolean; count: number; onSelect: (list: ListKind) => void }) {
	return (
		<Tooltip label={item.label}>
			<button type="button" className="rail-button" aria-label={item.label} aria-pressed={active} data-active={active} onClick={() => onSelect(item.list)}>
				<item.Icon size={20} />
				{count > 0 ? <span className="rail-button__badge">{count}</span> : null}
			</button>
		</Tooltip>
	);
}
