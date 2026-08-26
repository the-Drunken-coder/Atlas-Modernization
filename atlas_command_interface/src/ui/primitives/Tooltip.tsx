import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipProps = {
  label: string;
  placement?: "right" | "top";
  children: ReactNode;
};

type TooltipPosition = { left: number; top: number };

/** Lightweight hover/focus tooltip. Portals the label outside scroll containers. */
export function Tooltip({ label, placement = "right", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition>();
  const hostRef = useRef<HTMLSpanElement>(null);
  const updatePosition = useCallback(() => {
    const bounds = hostRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition(
      placement === "right"
        ? { left: bounds.right + 8, top: bounds.top + bounds.height / 2 }
        : { left: bounds.left + bounds.width / 2, top: bounds.top - 8 }
    );
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const close = () => {
    setOpen(false);
    setPosition(undefined);
  };

  return (
    <span
      ref={hostRef}
      className="tooltip-host"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={close}
    >
      {children}
      {open && position
        ? createPortal(
            <span className="tooltip" role="tooltip" data-placement={placement} style={position}>
              {label}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}
