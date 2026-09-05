import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useRef, useState } from "react";
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
    if (savingRef.current) return;
    setDraft(null);
    setError(undefined);
    points.current = [];
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
    const geometry: UiGeometry =
      draft.shape === "Circle"
        ? {
            type: "Feature",
            geometry: { type: "Point", coordinates: position },
            properties: { shape: "circle", radius_m: 100 }
          }
        : draft.shape === "Point" || next.length === 1
          ? { type: "Point", coordinates: position }
          : draft.shape === "Polygon" && next.length >= 3
            ? { type: "Polygon", coordinates: [[...next, next[0]]] }
            : { type: "LineString", coordinates: next };
    setDraft({ ...draft, geometry, drawing: draft.shape === "Polygon" || draft.shape === "LineString" });
  }

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
