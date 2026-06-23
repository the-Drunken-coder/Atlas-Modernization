import { useState, type ReactNode } from "react";

type TooltipProps = {
  label: string;
  placement?: "right" | "top";
  children: ReactNode;
};

/** Lightweight hover/focus tooltip. Renders the label only while open. */
export function Tooltip({ label, placement = "right", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="tooltip-host"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open ? (
        <span className="tooltip" role="tooltip" data-placement={placement}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
