import { Button as BlueprintButton, type ButtonProps as BlueprintButtonProps } from "@blueprintjs/core";
import { forwardRef, type ReactNode } from "react";
import { ChevronRightIcon } from "../../ui/primitives/icons.js";

type PanelListRowProps = Omit<BlueprintButtonProps, "alignText" | "children" | "fill" | "minimal"> & {
  title: ReactNode;
  meta?: ReactNode;
  indicatorColor?: string;
  selected?: boolean;
  showChevron?: boolean;
};

/** The standard selectable row used by sidebar browsers. */
export const PanelListRow = forwardRef<HTMLButtonElement, PanelListRowProps>(function PanelListRow(
  { title, meta, indicatorColor = "transparent", selected, showChevron = true, className, ...props },
  ref
) {
  return (
    <BlueprintButton
      ref={ref}
      type="button"
      className={`entity-row${className ? ` ${className}` : ""}`}
      minimal
      fill
      alignText="start"
      data-selected={selected || undefined}
      {...props}
    >
      <span className="entity-row__dot" style={{ background: indicatorColor }} aria-hidden />
      <span className="entity-row__main">
        <span className="entity-row__name">{title}</span>
        {meta ? <span className="entity-row__meta">{meta}</span> : null}
      </span>
      {showChevron ? <ChevronRightIcon size={12} className="entity-row__chevron" /> : null}
    </BlueprintButton>
  );
});
