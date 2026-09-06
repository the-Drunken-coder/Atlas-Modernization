import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useEffect, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import type { AtlasDataSource } from "../../atlas/data-source.js";
import { type Position, type UiGeometry, validateGeometry } from "../../atlas/geometry.js";

export type DrawingShape = "Point" | "LineString" | "Polygon" | "Circle";

export function useGeofeatureCreate(
  create: AtlasDataSource["createGeofeature"],
  onCreated: (entity: EntityResource) => void
) {
  const [draft, setDraft] = useState<{
    id: string;
    name: string;
    shape: DrawingShape;
    geometry?: UiGeometry;
    drawing: boolean;
  } | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const points = useRef<Position[]>([]);

  function start() {
    if (savingRef.current) return;
    points.current = [];
    setError(undefined);
    setDraft({ id: crypto.randomUUID(), name: "", shape: "Polygon", drawing: true });
  }

  function cancel() {
    if (savingRef.current) return false;
    if ((draft?.name.trim() || draft?.geometry) && !window.confirm("Discard this Geo Feature draft?")) return false;
    setDraft(null);
    setError(undefined);
    points.current = [];
    return true;
  }

  function redraw(shape: DrawingShape) {
    if (savingRef.current) return;
    points.current = [];
    setError(undefined);
    setDraft((current) => current && { ...current, shape, geometry: undefined, drawing: true });
  }

  function addPoint(position: Position) {
    if (!draft?.drawing || savingRef.current) return;
    const next = [...points.current, position];
    points.current = next;
    setDraft({
      ...draft,
      geometry: geometryFromPoints(draft.shape, next),
      drawing: draft.shape === "Polygon" || draft.shape === "LineString"
    });
  }

  function undo() {
    if (!draft?.drawing || savingRef.current || points.current.length === 0) return;
    points.current = points.current.slice(0, -1);
    setDraft({ ...draft, geometry: geometryFromPoints(draft.shape, points.current) });
  }

  useEffect(() => {
    if (!draft?.drawing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Backspace" ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          event.target.closest("input, textarea, select, [role='textbox'], [role='dialog']"))
      )
        return;
      event.preventDefault();
      undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const canFinish = Boolean(
    draft?.geometry && draft.geometry.type === draft.shape && validateGeometry(draft.geometry).valid
  );
  const canSave = Boolean(
    draft?.name.trim() && draft.geometry && !draft.drawing && validateGeometry(draft.geometry).valid
  );

  async function save() {
    if (!draft?.geometry || !canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const entity = await create(draft.id, draft.name.trim(), draft.geometry);
      setDraft(null);
      onCreated(entity);
    } catch (cause) {
      setError(sanitizeConnectionError(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return {
    draft,
    error,
    saving,
    points: points.current,
    undo,
    canUndo: Boolean(draft?.drawing && points.current.length),
    canFinish,
    canSave,
    start,
    cancel,
    redraw,
    addPoint,
    save,
    finish: () => {
      if (canFinish) setDraft((current) => current && { ...current, drawing: false });
    },
    setName: (name: string) => {
      if (!savingRef.current) setDraft((current) => current && { ...current, name });
    },
    changeGeometry: (geometry: UiGeometry) => {
      if (!savingRef.current) setDraft((current) => current && { ...current, geometry });
    }
  };
}

export type GeofeatureCreation = ReturnType<typeof useGeofeatureCreate>;

function geometryFromPoints(shape: DrawingShape, points: Position[]): UiGeometry | undefined {
  const first = points[0];
  if (!first) return undefined;
  if (shape === "Circle")
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: first },
      properties: { shape: "circle", radius_m: 100 }
    };
  if (shape === "Point" || points.length === 1) return { type: "Point", coordinates: first };
  if (shape === "Polygon" && points.length >= 3) return { type: "Polygon", coordinates: [[...points, first]] };
  return { type: "LineString", coordinates: points };
}
