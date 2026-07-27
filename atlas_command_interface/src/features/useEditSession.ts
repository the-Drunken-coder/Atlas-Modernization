import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useState } from "react";
import { entityGeometry } from "../atlas/entities.js";
import type { UiGeometry } from "../atlas/geometry.js";
import type { AtlasContextValue } from "../state/atlas-context.js";

export type EditState = { entityId: string; version: number; draft: UiGeometry };

export type EditSession = {
  edit: EditState | null;
  saving: boolean;
  saveError?: string;
  startEdit: () => void;
  changeDraft: (geometry: UiGeometry) => void;
  saveEdit: () => Promise<void>;
  cancelEdit: () => void;
};

/**
 * Owns a geometry edit session for the selected entity. The session pins the
 * entity version captured when editing started and is dropped when the
 * selection moves on or the entity disappears from the snapshot.
 */
export function useEditSession({
  updateGeometry,
  selectedEntity,
  selectedId
}: {
  updateGeometry: AtlasContextValue["updateGeometry"];
  selectedEntity?: EntityResource;
  selectedId?: string;
}): EditSession {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;

  // Drop an edit session when the selection moves to another entity.
  useEffect(() => {
    if (edit && edit.entityId !== selectedId) {
      setEdit(null);
      setSaveError(undefined);
    }
  }, [edit, selectedId]);

  // Live updates can remove the selected entity while the sidebar still holds
  // its ID; an edit session must follow the snapshot.
  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    setEdit(null);
    setSaveError(undefined);
  }, [selectedId, selectedEntityId]);

  const startEdit = useCallback(() => {
    if (!selectedEntity) return;
    const geometry = entityGeometry(selectedEntity);
    if (!geometry) return;
    setSaveError(undefined);
    setEdit({ entityId: selectedEntity.entity_id, version: selectedEntity.metadata.version, draft: geometry });
  }, [selectedEntity]);

  const changeDraft = useCallback((geometry: UiGeometry) => {
    setEdit((current) => (current ? { ...current, draft: geometry } : current));
  }, []);

  const saveEdit = useCallback(async () => {
    if (!edit || !selectedEntity) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await updateGeometry(edit.entityId, edit.draft, edit.version);
      setEdit(null);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [updateGeometry, edit, selectedEntity]);

  const cancelEdit = useCallback(() => {
    setEdit(null);
    setSaveError(undefined);
  }, []);

  return { edit, saving, saveError, startEdit, changeDraft, saveEdit, cancelEdit };
}
