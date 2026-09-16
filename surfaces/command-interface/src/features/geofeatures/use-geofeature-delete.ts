import { useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import type { AtlasDataSource } from "../../atlas/data-source.js";

type DeleteState = { entityId?: string; instanceId?: string; error?: string };

export function useGeofeatureDelete(
  deleteGeofeature: AtlasDataSource["deleteGeofeature"],
  canDeleteGeofeature: AtlasDataSource["canDeleteGeofeature"],
  onDeleted: (entityId: string, instanceId: string) => void
) {
  const [state, setState] = useState<DeleteState>({});

  const remove = async (entityId: string, instanceId: string, displayName: string) => {
    if (
      !deleteGeofeature ||
      (state.entityId && !state.error) ||
      !window.confirm(`Delete "${displayName}"? This cannot be undone.`)
    )
      return;
    setState({ entityId, instanceId });
    try {
      await deleteGeofeature(entityId, instanceId);
      setState({});
      onDeleted(entityId, instanceId);
    } catch (cause) {
      setState({ entityId, instanceId, error: sanitizeConnectionError(cause) });
    }
  };

  return {
    available: (entityId: string, instanceId: string) =>
      Boolean(deleteGeofeature && (!canDeleteGeofeature || canDeleteGeofeature(entityId, instanceId))),
    deleting: (_entityId: string) => Boolean(state.entityId && !state.error),
    error: (entityId: string, instanceId: string) =>
      state.entityId === entityId && state.instanceId === instanceId ? state.error : undefined,
    remove
  };
}
