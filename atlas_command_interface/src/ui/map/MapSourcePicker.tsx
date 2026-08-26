import { type RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import type { MapSourceConfig } from "../../app/config.js";
import { DoubleCaretVerticalIcon, TickIcon } from "../primitives/icons.js";

type MapSourcePickerProps = {
  sources: MapSourceConfig[];
  defaultSourceId: string;
  value: string;
  previewSourceId?: string;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  onPreview: (value: string) => void;
};

export function MapSourcePicker({
  sources,
  defaultSourceId,
  value,
  previewSourceId,
  triggerRef: providedTriggerRef,
  onPreview
}: MapSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState(value);
  const pickerRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = providedTriggerRef ?? internalTriggerRef;
  const labelId = useId();
  const listboxId = useId();
  const orderedSources = useMemo(
    () => [
      ...sources.filter((source) => source.id === defaultSourceId),
      ...sources.filter((source) => source.id !== defaultSourceId)
    ],
    [defaultSourceId, sources]
  );
  const selectedSource = sources.find((source) => source.id === value);

  useEffect(() => {
    if (!open) return;
    const activeOption = Array.from(
      pickerRef.current?.querySelectorAll<HTMLButtonElement>("[data-source-id]") ?? []
    ).find((option) => option.dataset.sourceId === activeSourceId);
    activeOption?.focus();

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [activeSourceId, open]);

  const openMenu = (edge?: "first" | "last") => {
    const availableSources = orderedSources.filter((source) => source.style);
    const selectedAvailableSource = availableSources.find((source) => source.id === value);
    const nextActiveSource =
      edge === "first"
        ? availableSources[0]
        : edge === "last"
          ? availableSources.at(-1)
          : (selectedAvailableSource ?? availableSources[0]);
    if (nextActiveSource) setActiveSourceId(nextActiveSource.id);
    setOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div ref={pickerRef} className="map-source-control">
      <label id={labelId} className="map-source-control__label" htmlFor={`${listboxId}-trigger`}>
        Map
      </label>
      <button
        ref={triggerRef}
        id={`${listboxId}-trigger`}
        type="button"
        className="map-source-trigger"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
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
        <span>{selectedSource?.label ?? value}</span>
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
            const availableOptions = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not([disabled])')
            );
            if (availableOptions.length === 0) return;
            const currentIndex = availableOptions.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? availableOptions.length - 1
                  : event.key === "ArrowDown"
                    ? (Math.max(currentIndex, -1) + 1) % availableOptions.length
                    : (currentIndex <= 0 ? availableOptions.length : currentIndex) - 1;
            const nextOption = availableOptions[nextIndex];
            setActiveSourceId(nextOption.dataset.sourceId ?? "");
            nextOption.focus();
          }}
        >
          {orderedSources.map((source) => {
            const selected = source.id === value;
            const previewing = source.id === previewSourceId;
            return (
              <button
                key={source.id}
                type="button"
                role="option"
                className="map-source-option"
                aria-selected={selected}
                disabled={!source.style}
                data-selected={selected || undefined}
                data-source-id={source.id}
                tabIndex={source.style && source.id === activeSourceId ? 0 : -1}
                onFocus={() => setActiveSourceId(source.id)}
                onClick={() => {
                  if (!source.style) return;
                  if (!selected) onPreview(source.id);
                  closeMenu(true);
                }}
              >
                <span className="map-source-option__label">{source.label}</span>
                {source.unavailableReason || previewing ? (
                  <span className="map-source-option__reason">{source.unavailableReason ?? "Previewing"}</span>
                ) : null}
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
