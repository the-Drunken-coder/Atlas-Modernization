import type { CommandCatalog, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { entityKind } from "../../atlas/entities.js";
import type { AtlasContextValue } from "../../state/atlas-context.js";
import type { MapContextMenuInfo } from "../../ui/map/view/MapView.js";
import type { CommandManifestStatus } from "../assets/AssetInspector.js";
import type { CommandMapPoint } from "./command-input-registry.js";

export type MapMenuState = { x: number; y: number; lat: number; lng: number };
export type CommandFormState = {
  availability: CommandAvailability;
  mapPoint?: CommandMapPoint;
  manifestGeneration?: number;
};
type PendingSubmission = { identity: string; idempotencyKey: string };
type PendingMapMenu = { entityId: string; info: MapContextMenuInfo };

export function useCommandFlow({
  catalog,
  selectedEntity,
  selectedId,
  commandManifestStatus = "ready",
  commandManifestGeneration,
  submitCommand
}: {
  catalog?: CommandCatalog;
  selectedEntity?: EntityResource;
  selectedId?: string;
  commandManifestStatus?: CommandManifestStatus;
  commandManifestGeneration?: number;
  submitCommand: AtlasContextValue["submitCommand"];
}) {
  const [mapMenu, setMapMenu] = useState<MapMenuState | null>(null);
  const [pendingMapMenu, setPendingMapMenu] = useState<PendingMapMenu | null>(null);
  const [commandForm, setCommandForm] = useState<CommandFormState | null>(null);
  const nextSubmitIdRef = useRef(1);
  const activeSubmitIdRef = useRef<number | undefined>(undefined);
  const pendingSubmissionRef = useRef<PendingSubmission | undefined>(undefined);
  const previousSelectedIdRef = useRef(selectedId);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const selectedEntityId = selectedEntity?.entity_id;
  const selectedEntityRef = useRef(selectedEntity);
  selectedEntityRef.current = selectedEntity;
  const manifestStatusRef = useRef(commandManifestStatus);
  manifestStatusRef.current = commandManifestStatus;
  const manifestGenerationRef = useRef(commandManifestGeneration);
  manifestGenerationRef.current = commandManifestGeneration;
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;

  const closeMapMenu = useCallback(() => setMapMenu(null), []);
  const dismissCommandForm = useCallback(() => {
    pendingSubmissionRef.current = undefined;
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
    setPendingMapMenu(null);
  }, [catalog, closeMapMenu, dismissCommandForm]);

  useEffect(() => {
    if (commandManifestStatus !== "ready") {
      setCommandForm(null);
      return;
    }
    if (commandForm && commandForm.manifestGeneration !== commandManifestGeneration) {
      setCommandForm(null);
    }
  }, [commandForm, commandManifestGeneration, commandManifestStatus]);

  useEffect(() => {
    const previousSelectedId = previousSelectedIdRef.current;
    previousSelectedIdRef.current = selectedId;
    if (pendingMapMenu && previousSelectedId !== selectedId && pendingMapMenu.entityId !== selectedId) {
      setPendingMapMenu(null);
    }
  }, [pendingMapMenu, selectedId]);

  useEffect(() => {
    if (!pendingMapMenu || pendingMapMenu.entityId !== selectedEntityId) return;
    setPendingMapMenu(null);
    if (!selectedEntity || entityKind(selectedEntity) !== "asset") return;
    dismissCommandForm();
    const { info } = pendingMapMenu;
    setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
  }, [pendingMapMenu, selectedEntity, selectedEntityId, dismissCommandForm]);

  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    closeMapMenu();
    dismissCommandForm();
    setPendingMapMenu(null);
  }, [selectedId, selectedEntityId, closeMapMenu, dismissCommandForm]);

  const submit = useCallback(
    async (
      availability: CommandAvailability,
      input: JSONValue,
      expectedManifestGeneration = commandManifestGeneration
    ) => {
      const currentEntity = selectedEntityRef.current;
      if (
        !currentEntity ||
        manifestStatusRef.current !== "ready" ||
        expectedManifestGeneration !== manifestGenerationRef.current ||
        !availabilityMatchesManifest(currentEntity, availability)
      ) {
        return;
      }
      const identity = JSON.stringify([currentEntity.entity_id, availability.command.command, input]);
      const existing = pendingSubmissionRef.current;
      const pending = existing?.identity === identity ? existing : { identity, idempotencyKey: crypto.randomUUID() };
      pendingSubmissionRef.current = pending;
      const submitId = nextSubmitIdRef.current++;
      activeSubmitIdRef.current = submitId;
      setSubmitting(true);
      setSubmitError(undefined);
      try {
        await submitCommand({
          assetId: currentEntity.entity_id,
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
    [commandManifestGeneration, submitCommand]
  );

  const pick = useCallback(
    (availability: CommandAvailability, mapPoint?: CommandMapPoint) => {
      const currentEntity = selectedEntityRef.current;
      if (
        submittingRef.current ||
        manifestStatusRef.current !== "ready" ||
        !currentEntity ||
        !availabilityMatchesManifest(currentEntity, availability)
      ) {
        return;
      }
      closeMapMenu();
      if (availability.input.Form) {
        setSubmitError(undefined);
        setCommandForm({ availability, mapPoint, manifestGeneration: manifestGenerationRef.current });
        return;
      }
      void submit(
        availability,
        availability.input.buildInput({ asset: currentEntity, command: availability.command, mapPoint })
      );
    },
    [closeMapMenu, submit]
  );

  const onMapContextMenu = useCallback(
    (info: MapContextMenuInfo) => {
      if (info.entityId && info.entityId !== selectedEntityId) {
        closeMapMenu();
        dismissCommandForm();
        setPendingMapMenu({ entityId: info.entityId, info });
        return;
      }
      setPendingMapMenu(null);
      if (!selectedEntity || entityKind(selectedEntity) !== "asset") {
        closeMapMenu();
        return;
      }
      dismissCommandForm();
      setMapMenu({ x: info.x, y: info.y, lat: info.lat, lng: info.lng });
    },
    [selectedEntity, selectedEntityId, closeMapMenu, dismissCommandForm]
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

function availabilityMatchesManifest(entity: EntityResource, availability: CommandAvailability): boolean {
  const manifestEntry = entity.command_manifest?.find((entry) => entry.command === availability.command.command);
  return manifestEntry !== undefined && JSON.stringify(manifestEntry) === JSON.stringify(availability.manifest);
}
