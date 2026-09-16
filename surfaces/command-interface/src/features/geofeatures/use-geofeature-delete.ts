import { useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import type { AtlasDataSource } from "../../atlas/data-source.js";

type DeleteState = { entityId?: string; deleting: boolean; error?: string };

export function useGeofeatureDelete(
  deleteGeofeature: NonNullable<AtlasDataSource["deleteGeofeature"]>,
  onDeleted: () => void
) {
  const [state, setState] = useState<DeleteState>({ deleting: false });

  const remove = async (entityId: string, displayName: string) => {
    if (state.deleting || !window.confirm(`Delete "${displayName}"? This cannot be undone.`)) return;
    setState({ entityId, deleting: true });
    try {
      await deleteGeofeature(entityId);
      onDeleted();
    } catch (cause) {
      setState({ entityId, deleting: false, error: sanitizeConnectionError(cause) });
    }
  };

  return {
    deleting: (entityId: string) => state.entityId === entityId && state.deleting,
    error: (entityId: string) => (state.entityId === entityId ? state.error : undefined),
    remove
  };
}
