import { Menu, MenuItem } from "@blueprintjs/core";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItemDef = {
  key: string;
  title: string;
  sub?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  onSelect?: () => void;
};

type ContextMenuProps = {
  x: number;
  y: number;
  header?: ReactNode;
  items: MenuItemDef[];
  emptyLabel?: string;
  onClose: () => void;
};

/** A docked, position-fixed context menu. Closes on outside click or Escape. */
export function ContextMenu({ x, y, header, items, emptyLabel, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLUListElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  const [activeKey, setActiveKey] = useState(() => items.find((item) => !item.disabled)?.key);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    const menu = menuRef.current;
    const firstItem = menu?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
    (firstItem ?? menu)?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  useEffect(() => {
    if (items.some((item) => item.key === activeKey && !item.disabled)) return;
    const nextKey = items.find((item) => !item.disabled)?.key;
    setActiveKey(nextKey);
    const menu = menuRef.current;
    const nextItem = nextKey
      ? Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).find(
          (item) => item.dataset.menuKey === nextKey
        )
      : undefined;
    (nextItem ?? menu)?.focus();
  }, [activeKey, items]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      setPosition({ x, y });
      return;
    }
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: clamp(x, margin, Math.max(margin, window.innerWidth - rect.width - margin)),
      y: clamp(y, margin, Math.max(margin, window.innerHeight - rect.height - margin))
    });
  }, [x, y, header, items, emptyLabel]);

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 55 }}
        onClick={onClose}
        onContextMenu={(event) => event.preventDefault()}
      />
      <Menu
        ulRef={menuRef}
        className="context-menu"
        style={{ left: position.x, top: position.y }}
        aria-label="Position commands"
        tabIndex={items.some((item) => !item.disabled) ? -1 : 0}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const enabledItems = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')
          );
          if (enabledItems.length === 0) return;
          const currentIndex = enabledItems.indexOf(document.activeElement as HTMLButtonElement);
          const nextIndex =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? enabledItems.length - 1
                : event.key === "ArrowDown"
                  ? (Math.max(currentIndex, -1) + 1) % enabledItems.length
                  : (currentIndex <= 0 ? enabledItems.length : currentIndex) - 1;
          const next = enabledItems[nextIndex];
          setActiveKey(next.dataset.menuKey);
          next.focus();
        }}
      >
        {header ? (
          <li className="context-menu__header" role="none">
            {header}
          </li>
        ) : null}
        {items.length === 0 ? <MenuItem className="menu-item" disabled text={emptyLabel ?? "No actions"} /> : null}
        {items.map((item) => (
          <MenuItem
            key={item.key}
            tagName="button"
            className="menu-item"
            disabled={item.disabled}
            data-menu-key={item.key}
            tabIndex={item.disabled ? -1 : item.key === activeKey ? 0 : -1}
            htmlTitle={item.disabled ? item.disabledReason : undefined}
            text={
              <>
                <span className="menu-item__title">{item.title}</span>
                {item.disabled && item.disabledReason ? (
                  <span className="menu-item__sub">{item.disabledReason}</span>
                ) : item.sub ? (
                  <span className="menu-item__sub">{item.sub}</span>
                ) : null}
              </>
            }
            multiline
            onFocus={() => setActiveKey(item.key)}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
          />
        ))}
      </Menu>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
