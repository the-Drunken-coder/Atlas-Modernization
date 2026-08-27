import { type CSSProperties, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MapSourceConfig } from "../../app/config.js";
import { DoubleCaretVerticalIcon, TickIcon } from "../primitives/icons.js";

type MapSourcePickerProps = {
  sources: MapSourceConfig[];
  defaultSourceId: string;
  value: string;
  onChange: (value: string) => void;
};

export function MapSourcePicker({ sources, defaultSourceId, value, onChange }: MapSourcePickerProps) {
  const orderedSources = useMemo(
    () => [
      ...sources.filter((source) => source.id === defaultSourceId),
      ...sources.filter((source) => source.id !== defaultSourceId)
    ],
    [defaultSourceId, sources]
  );

  return <MapSourceSelect sources={orderedSources} value={value} label="Map" onChange={onChange} overlay />;
}

type MapSourceSelectProps = {
  sources: MapSourceConfig[];
  value: string;
  label: string;
  placeholder?: string;
  overlay?: boolean;
  onChange: (value: string) => void;
};

type MenuLayout = {
  placement: "above" | "below";
  style: CSSProperties;
};

export function MapSourceSelect({
  sources,
  value,
  label,
  placeholder = "No source available",
  overlay = false,
  onChange
}: MapSourceSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeSourceId, setActiveSourceId] = useState(value);
  const [menuLayout, setMenuLayout] = useState<MenuLayout | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listboxId = useId();
  const selectedSource = sources.find((source) => source.id === value);

  useEffect(() => {
    if (!open) return;
    const activeOption = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[data-source-id]") ?? []
    ).find((option) => option.dataset.sourceId === activeSourceId);
    activeOption?.focus();

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !pickerRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [activeSourceId, open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuLayout(null);
      return;
    }
    const picker = pickerRef.current;
    const menu = menuRef.current;
    const boundary = picker?.closest<HTMLElement>(".map-canvas");
    if (!picker || !menu || !boundary) return;

    const positionMenu = () => {
      const pickerBounds = picker.getBoundingClientRect();
      const boundaryBounds = boundary.getBoundingClientRect();
      const above = Math.max(0, pickerBounds.top - boundaryBounds.top - 4);
      const below = Math.max(0, boundaryBounds.bottom - pickerBounds.bottom - 4);
      const idealHeight = Math.min(360, menu.scrollHeight || 360);
      const placement = below >= idealHeight || below >= above ? "below" : "above";
      const maxHeight = Math.floor(Math.min(360, placement === "below" ? below : above));
      const maxWidth = Math.max(0, boundaryBounds.width - 20);
      const minWidth = Math.min(maxWidth, pickerBounds.width + 2);
      menu.style.minWidth = `${minWidth}px`;
      menu.style.maxWidth = `${maxWidth}px`;
      const menuWidth = Math.min(maxWidth, Math.max(minWidth, menu.scrollWidth || minWidth));
      const left = Math.max(
        10,
        Math.min(boundaryBounds.width - menuWidth - 10, pickerBounds.left - boundaryBounds.left - 1)
      );
      setMenuLayout({
        placement,
        style: {
          right: "auto",
          left,
          top: placement === "below" ? pickerBounds.bottom - boundaryBounds.top + 4 : "auto",
          bottom: placement === "above" ? boundaryBounds.bottom - pickerBounds.top + 4 : "auto",
          minWidth,
          maxWidth,
          maxHeight
        }
      });
    };

    positionMenu();
    const observer = new ResizeObserver(positionMenu);
    observer.observe(boundary);
    observer.observe(picker);
    const panel = picker.closest(".map-compare__panel");
    const mutationObserver = panel ? new MutationObserver(positionMenu) : undefined;
    if (panel) mutationObserver?.observe(panel, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer.disconnect();
      mutationObserver?.disconnect();
    };
  }, [open, sources]);

  const openMenu = (edge?: "first" | "last") => {
    const availableSources = sources.filter((source) => source.style);
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

  const focusAfterTrigger = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const scope = trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body;
    const focusable = Array.from(
      scope.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((candidate) => !menuRef.current?.contains(candidate));
    (focusable[focusable.indexOf(trigger) + 1] ?? trigger).focus();
  };

  const menuBoundary = open ? pickerRef.current?.closest<HTMLElement>(".map-canvas") : null;
  const menu = open ? (
    <div
      ref={menuRef}
      id={listboxId}
      className="map-source-menu"
      style={menuLayout?.style}
      data-placement={menuLayout?.placement}
      data-map-interaction-control
      role="listbox"
      aria-labelledby={labelId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
          return;
        }
        if (event.key === "Tab") {
          if (menuBoundary) {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) triggerRef.current?.focus();
            else focusAfterTrigger();
          }
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
      {sources.map((source) => {
        const selected = source.id === value;
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
              onChange(source.id);
              closeMenu(true);
            }}
          >
            <span className="map-source-option__label">{source.label}</span>
            {source.unavailableReason ? (
              <span className="map-source-option__reason">{source.unavailableReason}</span>
            ) : null}
            <span className="map-source-option__check" aria-hidden>
              {selected ? <TickIcon size={12} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div
      ref={pickerRef}
      className={`${overlay ? "map-overlay-tr " : ""}map-source-control`}
      data-map-interaction-control
    >
      <label id={labelId} className="map-source-control__label" htmlFor={`${listboxId}-trigger`}>
        {label}
      </label>
      <button
        ref={triggerRef}
        id={`${listboxId}-trigger`}
        type="button"
        className="map-source-trigger"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-map-source-trigger
        onClick={() => {
          if (open) closeMenu(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (open && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeMenu(true);
            return;
          }
          if (!open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            openMenu(event.key === "ArrowUp" || event.key === "End" ? "last" : "first");
          }
        }}
      >
        <span>{selectedSource?.label ?? placeholder}</span>
        <DoubleCaretVerticalIcon size={12} />
      </button>
      {menuBoundary && menu ? createPortal(menu, menuBoundary) : menu}
    </div>
  );
}
