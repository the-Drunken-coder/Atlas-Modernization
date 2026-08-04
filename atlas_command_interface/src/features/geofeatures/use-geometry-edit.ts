import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { entityGeometry } from "../../atlas/entities.js";
import type { UiGeometry } from "../../atlas/geometry.js";
import type { AtlasContextValue } from "../../state/atlas-context.js";

export type GeometryEditState = { entityId: string; version: number; draft: UiGeometry };

export function useGeometryEdit({
  selectedEntity,
  selectedId,
  updateGeometry
}: {
  selectedEntity?: EntityResource;
  selectedId?: string;
  updateGeometry: AtlasContextValue["updateGeometry"];
}) {
  const [edit, setEdit] = useState<GeometryEditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;

  const cancelEdit = useCallback(() => {
    setEdit(null);
    setSaveError(undefined);
  }, []);

  useEffect(() => {
    if (!edit || (edit.entityId === selectedId && selectedEntityId)) return;
    cancelEdit();
  }, [edit, selectedId, selectedEntityId, cancelEdit]);

  const startEdit = useCallback(() => {
    if (!selectedEntity) return;
    const geometry = entityGeometry(selectedEntity);
    if (!geometry) return;
    setSaveError(undefined);
    setEdit({ entityId: selectedEntity.entity_id, version: selectedEntity.metadata.version, draft: geometry });
  }, [selectedEntity]);

  const changeDraft = useCallback((draft: UiGeometry) => {
    setEdit((current) => (current ? { ...current, draft } : current));
  }, []);

  const saveEdit = useCallback(async () => {
    if (!edit || !selectedEntity) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await updateGeometry(edit.entityId, edit.draft, edit.version);
      setEdit(null);
    } catch (cause) {
      setSaveError(sanitizeConnectionError(cause));
    } finally {
      setSaving(false);
    }
  }, [edit, selectedEntity, updateGeometry]);

  return { edit, saving, saveError, startEdit, changeDraft, saveEdit, cancelEdit };
}
