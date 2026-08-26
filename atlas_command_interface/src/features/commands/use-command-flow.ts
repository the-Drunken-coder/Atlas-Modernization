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
type PendingSubmission = { identity: string; idempotencyKey: string };

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
  const [mapTargeting, setMapTargeting] = useState<CommandAvailability | null>(null);
  const [commandForm, setCommandForm] = useState<CommandFormState | null>(null);
  const nextSubmitIdRef = useRef(1);
  const activeSubmitIdRef = useRef<number | undefined>(undefined);
  const pendingSubmissionRef = useRef<PendingSubmission | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;

  const closeMapMenu = useCallback(() => setMapMenu(null), []);
  const cancelMapTargeting = useCallback(() => setMapTargeting(null), []);
  const dismissCommandForm = useCallback(() => {
    pendingSubmissionRef.current = undefined;
    setCommandForm(null);
    setSubmitError(undefined);
  }, []);

  useEffect(() => {
    closeMapMenu();
    cancelMapTargeting();
    dismissCommandForm();
  }, [selectedId, closeMapMenu, cancelMapTargeting, dismissCommandForm]);

  useEffect(() => {
    closeMapMenu();
    cancelMapTargeting();
    if (activeSubmitIdRef.current === undefined) dismissCommandForm();
  }, [catalog, closeMapMenu, cancelMapTargeting, dismissCommandForm]);

  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    closeMapMenu();
    cancelMapTargeting();
    dismissCommandForm();
  }, [selectedId, selectedEntityId, closeMapMenu, cancelMapTargeting, dismissCommandForm]);

  useEffect(() => {
    if (!mapTargeting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMapTargeting(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mapTargeting]);

  useEffect(() => {
    if (mapTargeting && !commandIsStillAvailable(mapTargeting, catalog, selectedEntity)) {
      cancelMapTargeting();
    }
  }, [mapTargeting, catalog, selectedEntity, cancelMapTargeting]);

  const submit = useCallback(
    async (availability: CommandAvailability, input: JSONValue) => {
      if (!selectedEntity) return;
      const identity = JSON.stringify([selectedEntity.entity_id, availability.command.command, input]);
      const existing = pendingSubmissionRef.current;
      const pending = existing?.identity === identity ? existing : { identity, idempotencyKey: crypto.randomUUID() };
      pendingSubmissionRef.current = pending;
      const submitId = nextSubmitIdRef.current++;
      activeSubmitIdRef.current = submitId;
      setSubmitting(true);
      setSubmitError(undefined);
      try {
        await submitCommand({
          assetId: selectedEntity.entity_id,
          command: availability.command,
          input,
          idempotencyKey: pending.idempotencyKey
        });
        if (pendingSubmissionRef.current === pending) pendingSubmissionRef.current = undefined;
        setCommandForm(null);
      } catch (cause) {
        if (pendingSubmissionRef.current === pending) setSubmitError(sanitizeConnectionError(cause));
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
        pendingSubmissionRef.current = undefined;
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

  const startMapTargeting = useCallback(
    (availability: CommandAvailability) => {
      if (availability.input.targeting !== "map_point" || submitting || !selectedEntity) return;
      closeMapMenu();
      dismissCommandForm();
      setMapTargeting(availability);
    },
    [closeMapMenu, dismissCommandForm, selectedEntity, submitting]
  );

  const onMapContextMenu = useCallback(
    (info: MapContextMenuInfo) => {
      if (!selectedEntity || entityKind(selectedEntity) !== "asset") {
        closeMapMenu();
        return;
      }
      dismissCommandForm();
      if (mapTargeting) {
        if (!commandIsStillAvailable(mapTargeting, catalog, selectedEntity)) {
          cancelMapTargeting();
          return;
        }
        setMapTargeting(null);
        pick(mapTargeting, { lat: info.lat, lng: info.lng });
        return;
      }
      setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
    },
    [selectedEntity, catalog, closeMapMenu, cancelMapTargeting, dismissCommandForm, mapTargeting, pick]
  );

  return {
    mapMenu,
    mapTargeting,
    commandForm,
    submitting,
    submitError,
    closeMapMenu,
    cancelMapTargeting,
    dismissCommandForm,
    pickSidebarCommand: (availability: CommandAvailability) => pick(availability),
    pickMapCommand: (availability: CommandAvailability, point: CommandMapPoint) => pick(availability, point),
    startMapTargeting,
    onMapContextMenu,
    submit
  };
}

function commandIsStillAvailable(
  availability: CommandAvailability,
  catalog: CommandCatalog | undefined,
  entity: EntityResource | undefined
): boolean {
  return Boolean(
    entity?.entity_type === "asset" &&
      catalog?.some((command) => command.command === availability.command.command) &&
      entity.command_manifest?.some((entry) => entry.command === availability.command.command)
  );
}
