import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { MapSourceConfig } from "../../app/config.js";
import {
  type MapSourceCoverageResult,
  type MapViewport,
  mapSourceCoverageAtViewport
} from "../../app/map-source-coverage.js";
import { DoubleCaretVerticalIcon, TickIcon } from "../primitives/icons.js";

type MapSourcePickerProps = {
  sources: MapSourceConfig[];
  defaultSourceId: string;
  value: string;
  viewport?: MapViewport;
  onChange: (value: string) => void;
};

type SourceState = MapSourceCoverageResult | { kind: "unavailable"; reason: string; selectable: false };

export function MapSourcePicker({ sources, defaultSourceId, value, viewport, onChange }: MapSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState(value);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const listboxId = useId();
  const orderedSources = useMemo(
    () => [
      ...sources.filter((source) => source.id === defaultSourceId),
      ...sources.filter((source) => source.id !== defaultSourceId)
    ],
    [defaultSourceId, sources]
  );
  const sourceStates = useMemo(
    () =>
      new Map(
        orderedSources.map((source) => [
          source.id,
          source.style
            ? mapSourceCoverageAtViewport(source.coverage, viewport)
            : ({
                kind: "unavailable",
                reason: source.unavailableReason ?? "Source unavailable",
                selectable: false
              } satisfies SourceState)
        ])
      ),
    [orderedSources, viewport]
  );
  const selectedSource = sources.find((source) => source.id === value);
  const selectedState = sourceStates.get(value);
  const triggerReasonId = `${listboxId}-trigger-reason`;

  useEffect(() => {
    if (!open) return;
    const activeOption = Array.from(
      pickerRef.current?.querySelectorAll<HTMLButtonElement>("[data-source-id]") ?? []
    ).find((option) => option.dataset.sourceId === activeSourceId);
    activeOption?.focus();
  }, [activeSourceId, open, sourceStates]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open || sourceStates.get(activeSourceId)?.selectable) return;
    const selectedSelectable = sourceStates.get(value)?.selectable ? value : undefined;
    const firstSelectable = orderedSources.find((source) => sourceStates.get(source.id)?.selectable)?.id;
    const nextActiveSourceId = selectedSelectable ?? firstSelectable;
    if (nextActiveSourceId) setActiveSourceId(nextActiveSourceId);
  }, [activeSourceId, open, orderedSources, sourceStates, value]);

  const openMenu = (edge?: "first" | "last") => {
    const selectableSources = orderedSources.filter((source) => sourceStates.get(source.id)?.selectable);
    const selectedSelectableSource = selectableSources.find((source) => source.id === value);
    const nextActiveSource =
      edge === "first"
        ? selectableSources[0]
        : edge === "last"
          ? selectableSources.at(-1)
          : (selectedSelectableSource ?? selectableSources[0]);
    if (nextActiveSource) setActiveSourceId(nextActiveSource.id);
    setOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div ref={pickerRef} className="map-overlay-tr map-source-control">
      <label id={labelId} className="map-source-control__label" htmlFor={`${listboxId}-trigger`}>
        Map
      </label>
      <button
        ref={triggerRef}
        id={`${listboxId}-trigger`}
        type="button"
        className="map-source-trigger"
        aria-controls={open ? listboxId : undefined}
        aria-describedby={selectedState?.kind !== "full" ? triggerReasonId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-coverage={selectedState?.kind}
        onClick={() => {
          if (open) closeMenu(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" || event.key === "End" ? "last" : "first");
          }
        }}
      >
        <span className="map-source-trigger__copy">
          <span className="map-source-trigger__label">{selectedSource?.label ?? value}</span>
          {selectedState?.kind !== "full" ? (
            <span id={triggerReasonId} className="map-source-trigger__reason">
              {selectedState?.reason}
            </span>
          ) : null}
        </span>
        <DoubleCaretVerticalIcon size={12} />
      </button>
      {open ? (
        <div
          id={listboxId}
          className="map-source-menu"
          role="listbox"
          aria-labelledby={labelId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeMenu(true);
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const selectableOptions = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not([disabled])')
            );
            if (selectableOptions.length === 0) return;
            const currentIndex = selectableOptions.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? selectableOptions.length - 1
                  : event.key === "ArrowDown"
                    ? (Math.max(currentIndex, -1) + 1) % selectableOptions.length
                    : (currentIndex <= 0 ? selectableOptions.length : currentIndex) - 1;
            const nextOption = selectableOptions[nextIndex];
            setActiveSourceId(nextOption.dataset.sourceId ?? "");
            nextOption.focus();
          }}
        >
          {orderedSources.map((source, index) => {
            const selected = source.id === value;
            const state = sourceStates.get(source.id);
            const optionLabelId = `${listboxId}-option-${index}-label`;
            const reasonId = `${listboxId}-option-${index}-reason`;
            return (
              <button
                key={source.id}
                type="button"
                role="option"
                className="map-source-option"
                aria-describedby={reasonId}
                aria-labelledby={optionLabelId}
                aria-selected={selected}
                disabled={!state?.selectable}
                data-coverage={state?.kind}
                data-selected={selected || undefined}
                data-source-id={source.id}
                tabIndex={state?.selectable && source.id === activeSourceId ? 0 : -1}
                onFocus={() => setActiveSourceId(source.id)}
                onClick={() => {
                  if (!state?.selectable) return;
                  onChange(source.id);
                  closeMenu(true);
                }}
              >
                <span className="map-source-option__copy">
                  <span id={optionLabelId} className="map-source-option__label">
                    {source.label}
                  </span>
                  <span id={reasonId} className="map-source-option__reason">
                    {state?.reason}
                  </span>
                </span>
                <span className="map-source-option__check" aria-hidden>
                  {selected ? <TickIcon size={12} /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
