import type { EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandCatalog } from "../atlas/command-model.js";
import type { CommandAvailability } from "../atlas/command-targeting.js";
import { entityKind } from "../atlas/entities.js";
import type { AtlasContextValue } from "../state/atlas-context.js";
import type { MapContextMenuInfo } from "../ui/map/view/MapView.js";

export type MapMenuState = { x: number; y: number; lat: number; lng: number };
export type CommandFormState = { availability: CommandAvailability; mapPoint?: { lat: number; lng: number } };

export type CommandFlow = {
  mapMenu: MapMenuState | null;
  commandForm: CommandFormState | null;
  submitting: boolean;
  submitError?: string;
  dismissCommandForm: () => void;
  closeMapMenu: () => void;
  submit: (
    availability: CommandAvailability,
    parameters: Record<string, JSONValue>,
    errorFormState?: CommandFormState
  ) => Promise<void>;
  pickSidebarCommand: (availability: CommandAvailability) => void;
  pickMapCommand: (availability: CommandAvailability, point: { lat: number; lng: number }) => void;
  onMapContextMenu: (info: MapContextMenuInfo) => void;
};

/**
 * Owns the transient command UI for the selected entity: the map context menu,
 * the parameter form, and submission plumbing. All of it follows the selection
 * and the live catalog, closing whenever either moves on.
 */
export function useCommandFlow({
  submitCommand,
  catalog,
  selectedEntity,
  selectedId
}: {
  submitCommand: AtlasContextValue["submitCommand"];
  catalog?: CommandCatalog;
  selectedEntity?: EntityResource;
  selectedId?: string;
}): CommandFlow {
  const [mapMenu, setMapMenu] = useState<MapMenuState | null>(null);
  const [commandForm, setCommandForm] = useState<CommandFormState | null>(null);
  const commandDismissedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;

  const dismissCommandForm = useCallback(() => {
    commandDismissedRef.current = true;
    setCommandForm(null);
    setSubmitError(undefined);
  }, []);

  const closeMapMenu = useCallback(() => setMapMenu(null), []);

  // Drop transient command UI when the selected entity changes.
  useEffect(() => {
    setMapMenu(null);
    dismissCommandForm();
  }, [selectedId, dismissCommandForm]);

  useEffect(() => {
    setMapMenu(null);
    dismissCommandForm();
  }, [catalog, dismissCommandForm]);

  // Live updates can remove the selected entity while the sidebar still holds
  // its ID; transient command UI must follow the snapshot.
  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    setMapMenu(null);
    dismissCommandForm();
  }, [selectedId, selectedEntityId, dismissCommandForm]);

  const submit = useCallback(
    async (
      availability: CommandAvailability,
      parameters: Record<string, JSONValue>,
      errorFormState?: CommandFormState
    ) => {
      if (!selectedEntity) return;
      commandDismissedRef.current = false;
      setSubmitting(true);
      setSubmitError(undefined);
      try {
        await submitCommand({ entityId: selectedEntity.entity_id, command: availability.command, parameters });
        setCommandForm(null);
      } catch (cause) {
        if (!commandDismissedRef.current) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setSubmitError(message);
          setCommandForm((current) => current ?? errorFormState ?? null);
        }
      } finally {
        commandDismissedRef.current = false;
        setSubmitting(false);
      }
    },
    [submitCommand, selectedEntity]
  );

  const pickSidebarCommand = useCallback(
    (availability: CommandAvailability) => {
      if (submitting || availability.disabled) return;
      if (availability.requiresForm) {
        setSubmitError(undefined);
        setCommandForm({ availability });
        return;
      }
      const formState = { availability };
      setCommandForm(formState);
      void submit(availability, {}, formState);
    },
    [submit, submitting]
  );

  const pickMapCommand = useCallback(
    (availability: CommandAvailability, point: { lat: number; lng: number }) => {
      if (submitting || availability.disabled) return;
      if (availability.requiresForm) {
        setSubmitError(undefined);
        setCommandForm({ availability, mapPoint: point });
        return;
      }
      const formState = { availability, mapPoint: point };
      setCommandForm(formState);
      void submit(availability, { latitude: point.lat, longitude: point.lng }, formState);
    },
    [submit, submitting]
  );

  const onMapContextMenu = useCallback(
    (info: MapContextMenuInfo) => {
      if (!selectedEntity || entityKind(selectedEntity) !== "asset") {
        setMapMenu(null);
        return;
      }
      dismissCommandForm();
      setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
    },
    [selectedEntity, dismissCommandForm]
  );

  return {
    mapMenu,
    commandForm,
    submitting,
    submitError,
    dismissCommandForm,
    closeMapMenu,
    submit,
    pickSidebarCommand,
    pickMapCommand,
    onMapContextMenu
  };
}
