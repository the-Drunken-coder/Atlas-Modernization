import type { CommandCatalog, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { entityKind } from "../../atlas/entities.js";
import type { AtlasContextValue } from "../../state/atlas-context.js";
import type { MapContextMenuInfo } from "../../ui/map/view/MapView.js";
import type { CommandMapPoint } from "./command-input-registry.js";

export type MapMenuState = { x: number; y: number; lat: number; lng: number };
export type CommandFormState = { availability: CommandAvailability; mapPoint?: CommandMapPoint };

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
  const nextSubmitIdRef = useRef(1);
  const activeSubmitIdRef = useRef<number | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;

  const closeMapMenu = useCallback(() => setMapMenu(null), []);
  const dismissCommandForm = useCallback(() => {
    setCommandForm(null);
    setSubmitError(undefined);
  }, []);

  useEffect(() => {
    closeMapMenu();
    dismissCommandForm();
  }, [selectedId, closeMapMenu, dismissCommandForm]);

  useEffect(() => {
    closeMapMenu();
    if (activeSubmitIdRef.current === undefined) dismissCommandForm();
  }, [catalog, closeMapMenu, dismissCommandForm]);

  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    closeMapMenu();
    dismissCommandForm();
  }, [selectedId, selectedEntityId, closeMapMenu, dismissCommandForm]);

  const submit = useCallback(
    async (availability: CommandAvailability, input: JSONValue) => {
      if (!selectedEntity) return;
      const submitId = nextSubmitIdRef.current++;
      activeSubmitIdRef.current = submitId;
      setSubmitting(true);
      setSubmitError(undefined);
      try {
        await submitCommand({
          assetId: selectedEntity.entity_id,
          command: availability.command,
          input,
          idempotencyKey: crypto.randomUUID()
        });
        setCommandForm(null);
      } catch (cause) {
        setSubmitError(sanitizeConnectionError(cause));
      } finally {
        if (activeSubmitIdRef.current === submitId) {
          activeSubmitIdRef.current = undefined;
          setSubmitting(false);
        }
      }
    },
    [selectedEntity, submitCommand]
  );

  const pick = useCallback(
    (availability: CommandAvailability, mapPoint?: CommandMapPoint) => {
      if (submitting || !selectedEntity) return;
      closeMapMenu();
      if (availability.input.Form) {
        setSubmitError(undefined);
        setCommandForm({ availability, mapPoint });
        return;
      }
      void submit(
        availability,
        availability.input.buildInput({ asset: selectedEntity, command: availability.command, mapPoint })
      );
    },
    [closeMapMenu, selectedEntity, submit, submitting]
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
    pickSidebarCommand: (availability: CommandAvailability) => pick(availability),
    pickMapCommand: (availability: CommandAvailability, point: CommandMapPoint) => pick(availability, point),
    onMapContextMenu,
    submit
  };
}
