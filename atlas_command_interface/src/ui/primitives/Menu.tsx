import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuItemDef = {
  key: string;
  title: string;
  sub?: string;
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
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
      <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={onClose} onContextMenu={(event) => event.preventDefault()} />
      <div ref={menuRef} className="context-menu" style={{ left: position.x, top: position.y }} role="menu">
        {header ? <div className="context-menu__header">{header}</div> : null}
        {items.length === 0 ? <div className="menu-item" aria-disabled>{emptyLabel ?? "No actions"}</div> : null}
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
          >
            <span className="menu-item__title">{item.title}</span>
            {item.disabled && item.disabledReason ? (
              <span className="menu-item__sub">{item.disabledReason}</span>
            ) : item.sub ? (
              <span className="menu-item__sub">{item.sub}</span>
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
