import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import { DoubleCaretVerticalIcon } from "../../primitives/icons.js";
import "../../styles/map-region-selection.css";

export type ScreenRect = { left: number; top: number; width: number; height: number };
export type ResizeAxes = "width" | "height" | "both";
export type RegionTransform = "move" | ResizeAxes;

type MapRegionSelectionProps = {
  rect: ScreenRect | null;
  drawing: boolean;
  drawingRect?: ScreenRect | null;
  drawingPrompt: string;
  label: string;
  testId: string;
  viewport?: { width: number; height: number };
  tinted?: boolean;
  onPointerDown(transform: RegionTransform, event: ReactPointerEvent<HTMLButtonElement>): void;
  onKeyDown(transform: RegionTransform, event: ReactKeyboardEvent<HTMLButtonElement>): void;
};

/** Shared map-region chrome for comparison and map-area operations. */
export function MapRegionSelection({
  rect,
  drawing,
  drawingRect,
  drawingPrompt,
  label,
  testId,
  viewport,
  tinted,
  onPointerDown,
  onKeyDown
}: MapRegionSelectionProps) {
  const resizeRightInside = Boolean(rect && viewport && rect.left + rect.width >= viewport.width - 14);
  const resizeBottomInside = Boolean(rect && viewport && rect.top + rect.height >= viewport.height - 14);

  return (
    <>
      {rect && !drawing ? (
        <div
          className={`map-region-selection${tinted ? " map-region-selection--tinted" : ""}`}
          style={rectStyle(rect)}
          data-resize-right-inside={resizeRightInside || undefined}
          data-resize-bottom-inside={resizeBottomInside || undefined}
          data-testid={testId}
        >
          <button
            type="button"
            className="map-region-selection__move-handle"
            data-map-interaction-control
            aria-label={`Move ${label}`}
            title="Drag or use arrow keys to move region"
            onPointerDown={(event) => onPointerDown("move", event)}
            onKeyDown={(event) => onKeyDown("move", event)}
          >
            <DoubleCaretVerticalIcon size={12} />
          </button>
          <button
            type="button"
            className="map-region-selection__resize-handle map-region-selection__resize-handle--right"
            data-map-interaction-control
            aria-label={`Resize ${label} width`}
            title="Drag horizontally or use Left and Right arrow keys"
            onPointerDown={(event) => onPointerDown("width", event)}
            onKeyDown={(event) => onKeyDown("width", event)}
          />
          <button
            type="button"
            className="map-region-selection__resize-handle map-region-selection__resize-handle--bottom"
            data-map-interaction-control
            aria-label={`Resize ${label} height`}
            title="Drag vertically or use Up and Down arrow keys"
            onPointerDown={(event) => onPointerDown("height", event)}
            onKeyDown={(event) => onKeyDown("height", event)}
          />
          <button
            type="button"
            className="map-region-selection__resize-handle map-region-selection__resize-handle--corner"
            data-map-interaction-control
            aria-label={`Resize ${label} width and height`}
            title="Drag diagonally or use arrow keys"
            onPointerDown={(event) => onPointerDown("both", event)}
            onKeyDown={(event) => onKeyDown("both", event)}
          />
        </div>
      ) : null}

      {drawing ? (
        <div className="map-region-selection__drawing-surface">
          {drawingRect && (drawingRect.width > 0 || drawingRect.height > 0) ? (
            <div className="map-region-selection__drawing-region" style={rectStyle(drawingRect)} />
          ) : null}
          <div className="map-region-selection__drawing-prompt" role="status">
            {drawingPrompt}
          </div>
        </div>
      ) : null}
    </>
  );
}

function rectStyle(rect: ScreenRect): CSSProperties {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}
