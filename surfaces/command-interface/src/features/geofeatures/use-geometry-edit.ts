import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const saveIdRef = useRef(0);
  const selectedEntityId = selectedEntity?.entity_id;

  const cancelEdit = useCallback(() => {
    saveIdRef.current += 1;
    setEdit(null);
    setSaving(false);
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
    saveIdRef.current += 1;
    setSaving(false);
    setSaveError(undefined);
    setEdit({ entityId: selectedEntity.entity_id, version: selectedEntity.metadata.version, draft: geometry });
  }, [selectedEntity]);

  const changeDraft = useCallback((draft: UiGeometry) => {
    setEdit((current) => (current ? { ...current, draft } : current));
  }, []);

  const saveEdit = useCallback(async () => {
    if (!edit || saving || edit.entityId !== selectedEntity?.entity_id) return;
    const submittedEdit = edit;
    const saveId = ++saveIdRef.current;
    setSaving(true);
    setSaveError(undefined);
    try {
      const updatedEntity = await updateGeometry(submittedEdit.entityId, submittedEdit.draft, submittedEdit.version);
      if (saveId === saveIdRef.current) {
        setEdit((current) => {
          if (!current) return null;
          return current === submittedEdit ? null : { ...current, version: updatedEntity.metadata.version };
        });
      }
    } catch (cause) {
      if (saveId === saveIdRef.current) setSaveError(sanitizeConnectionError(cause));
    } finally {
      if (saveId === saveIdRef.current) setSaving(false);
    }
  }, [edit, saving, selectedEntity, updateGeometry]);

  return { edit, saving, saveError, startEdit, changeDraft, saveEdit, cancelEdit };
}
