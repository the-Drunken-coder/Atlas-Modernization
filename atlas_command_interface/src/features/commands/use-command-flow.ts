import type { EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandCatalog } from "../../atlas/command-model.js";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { entityKind } from "../../atlas/entities.js";
import type { AtlasContextValue } from "../../state/atlas-context.js";
import type { MapContextMenuInfo } from "../../ui/map/view/MapView.js";

export type MapMenuState = { x: number; y: number; lat: number; lng: number };
export type CommandFormState = { availability: CommandAvailability; mapPoint?: { lat: number; lng: number } };

export function useCommandFlow({
  catalog,
  selectedEntity,
  selectedId,
  submitCommand
}: {
  catalog?: CommandCatalog;
  selectedEntity?: EntityResource;
  selectedId?: string;
  submitCommand: AtlasContextValue["submitCommand"];
}) {
  const [mapMenu, setMapMenu] = useState<MapMenuState | null>(null);
  const [commandForm, setCommandForm] = useState<CommandFormState | null>(null);
  const commandDismissedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;

  const closeMapMenu = useCallback(() => setMapMenu(null), []);
  const dismissCommandForm = useCallback(() => {
    commandDismissedRef.current = true;
    setCommandForm(null);
    setSubmitError(undefined);
  }, []);

  useEffect(() => {
    closeMapMenu();
    dismissCommandForm();
  }, [selectedId, closeMapMenu, dismissCommandForm]);

  useEffect(() => {
    closeMapMenu();
    dismissCommandForm();
  }, [catalog, closeMapMenu, dismissCommandForm]);

  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    closeMapMenu();
    dismissCommandForm();
  }, [selectedId, selectedEntityId, closeMapMenu, dismissCommandForm]);

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
          setSubmitError(sanitizeConnectionError(cause));
          setCommandForm((current) => current ?? errorFormState ?? null);
        }
      } finally {
        commandDismissedRef.current = false;
        setSubmitting(false);
      }
    },
    [selectedEntity, submitCommand]
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
        closeMapMenu();
        return;
      }
      dismissCommandForm();
      setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
    },
    [selectedEntity, closeMapMenu, dismissCommandForm]
  );

  return {
    mapMenu,
    commandForm,
    submitting,
    submitError,
    closeMapMenu,
    dismissCommandForm,
    pickSidebarCommand,
    pickMapCommand,
    onMapContextMenu,
    submit
  };
}
