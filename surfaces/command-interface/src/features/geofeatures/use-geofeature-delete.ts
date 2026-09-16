import { useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import type { AtlasDataSource } from "../../atlas/data-source.js";

type DeleteState = { entityId?: string; error?: string };

export function useGeofeatureDelete(
  deleteGeofeature: NonNullable<AtlasDataSource["deleteGeofeature"]>,
  onDeleted: (entityId: string) => void
) {
  const [state, setState] = useState<DeleteState>({});

  const remove = async (entityId: string, displayName: string) => {
    if ((state.entityId && !state.error) || !window.confirm(`Delete "${displayName}"? This cannot be undone.`)) return;
    setState({ entityId });
    try {
      await deleteGeofeature(entityId);
      setState({});
      onDeleted(entityId);
    } catch (cause) {
      setState({ entityId, error: sanitizeConnectionError(cause) });
    }
  };

  return {
    deleting: (_entityId: string) => Boolean(state.entityId && !state.error),
    error: (entityId: string) => (state.entityId === entityId ? state.error : undefined),
    remove
  };
}
