import { Tooltip as BlueprintTooltip } from "@blueprintjs/core";
import type { ReactNode } from "react";

type TooltipProps = {
  label: string;
  placement?: "right" | "top";
  children: ReactNode;
};

/** Blueprint tooltip with Atlas's compact timing and placement defaults. */
export function Tooltip({ label, placement = "right", children }: TooltipProps) {
  return (
    <BlueprintTooltip
      content={<span role="tooltip">{label}</span>}
      placement={placement}
      compact
      hoverOpenDelay={250}
      openOnTargetFocus
      transitionDuration={0}
    >
      {children}
    </BlueprintTooltip>
  );
}
