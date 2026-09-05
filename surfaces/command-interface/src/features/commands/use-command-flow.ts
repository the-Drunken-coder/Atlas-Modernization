import type { CommandCatalog, EntityResource, JSONValue } from "@the-drunken-coder/atlas-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandAvailability } from "../../atlas/command-targeting.js";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { entityKind } from "../../atlas/entities.js";
import type { AtlasContextValue } from "../../state/atlas-context.js";
import type { MapContextMenuInfo } from "../../ui/map/view/MapView.js";
import type { CommandManifestStatus } from "../assets/AssetInspector.js";
import type { CommandMapPoint } from "./command-input-registry.js";

type ManifestGeneration = number | string | undefined;

export type MapMenuState = { x: number; y: number; lat: number; lng: number; generation?: string };
export type CommandFormState = {
  availability: CommandAvailability;
  mapPoint?: CommandMapPoint;
  manifestGeneration?: ManifestGeneration;
  generation?: string;
};
type PendingSubmission = { identity: string; idempotencyKey: string };
type PendingMapMenu = { entityId: string; info: MapContextMenuInfo };

export function useCommandFlow({
  catalog,
  selectedEntity,
  selectedId,
  generation,
  commandManifestStatus = "ready",
  commandManifestGeneration,
  submitCommand
}: {
  catalog?: CommandCatalog;
  selectedEntity?: EntityResource;
  selectedId?: string;
  generation?: string;
  commandManifestStatus?: CommandManifestStatus;
  commandManifestGeneration?: ManifestGeneration;
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
  const manifestGeneration = commandManifestGeneration ?? generation;
  const manifestGenerationRef = useRef<ManifestGeneration>(manifestGeneration);
  manifestGenerationRef.current = manifestGeneration;
  const previousManifestGenerationRef = useRef<ManifestGeneration>(manifestGeneration);
  const previousSelectedEntityIdRef = useRef(selectedEntityId);
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;

  const closeMapMenu = useCallback(() => setMapMenu(null), []);
  const dismissCommandForm = useCallback(() => {
    pendingSubmissionRef.current = undefined;
    setCommandForm(null);
    setSubmitError(undefined);
  }, []);
  const invalidateCommandForm = useCallback(() => {
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
    const generationChanged = previousManifestGenerationRef.current !== manifestGeneration;
    previousManifestGenerationRef.current = manifestGeneration;
    const selectedEntityChanged = previousSelectedEntityIdRef.current !== selectedEntityId;
    previousSelectedEntityIdRef.current = selectedEntityId;
    if (generationChanged) {
      closeMapMenu();
      invalidateCommandForm();
      if (!selectedEntityChanged) setPendingMapMenu(null);
      return;
    }
    if (commandManifestStatus !== "ready") {
      closeMapMenu();
      if (commandManifestStatus === "unavailable") invalidateCommandForm();
      if (!selectedEntityChanged) setPendingMapMenu(null);
      return;
    }
    if (
      commandForm &&
      (commandForm.manifestGeneration !== commandManifestGeneration || commandForm.generation !== generation)
    ) {
      invalidateCommandForm();
    }
  }, [
    commandForm,
    commandManifestGeneration,
    commandManifestStatus,
    closeMapMenu,
    generation,
    invalidateCommandForm,
    manifestGeneration,
    selectedEntityId
  ]);

  useEffect(() => {
    const previousSelectedId = previousSelectedIdRef.current;
    previousSelectedIdRef.current = selectedId;
    if (pendingMapMenu && previousSelectedId !== selectedId && pendingMapMenu.entityId !== selectedId) {
      setPendingMapMenu(null);
    }
  }, [pendingMapMenu, selectedId]);

  useEffect(() => {
    if (!pendingMapMenu || pendingMapMenu.entityId !== selectedEntityId || commandManifestStatus !== "ready") return;
    setPendingMapMenu(null);
    if (!selectedEntity || entityKind(selectedEntity) !== "asset") return;
    dismissCommandForm();
    const { info } = pendingMapMenu;
    setMapMenu({
      x: info.x,
      y: info.y,
      lat: info.lat,
      lng: info.lng,
      ...(generation === undefined ? {} : { generation })
    });
  }, [commandManifestStatus, generation, pendingMapMenu, selectedEntity, selectedEntityId, dismissCommandForm]);

  useEffect(() => {
    if (!selectedId || selectedEntityId) return;
    closeMapMenu();
    dismissCommandForm();
    setPendingMapMenu(null);
  }, [selectedId, selectedEntityId, closeMapMenu, dismissCommandForm]);

  const submit = useCallback(
    async (availability: CommandAvailability, input: JSONValue, expectedGeneration = manifestGeneration) => {
      const currentEntity = selectedEntityRef.current;
      if (
        submittingRef.current ||
        activeSubmitIdRef.current !== undefined ||
        !currentEntity ||
        manifestStatusRef.current !== "ready" ||
        expectedGeneration !== manifestGenerationRef.current ||
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
        if (pendingSubmissionRef.current === pending) {
          pendingSubmissionRef.current = undefined;
          setCommandForm(null);
        }
      } catch (cause) {
        if (pendingSubmissionRef.current === pending) {
          setSubmitError(sanitizeConnectionError(cause));
        }
      } finally {
        if (activeSubmitIdRef.current === submitId) {
          activeSubmitIdRef.current = undefined;
          setSubmitting(false);
        }
      }
    },
    [manifestGeneration, submitCommand]
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
        setCommandForm({
          availability,
          mapPoint,
          ...(commandManifestGeneration === undefined ? {} : { manifestGeneration: commandManifestGeneration }),
          ...(generation === undefined ? {} : { generation })
        });
        return;
      }
      void submit(
        availability,
        availability.input.buildInput({ asset: currentEntity, command: availability.command, mapPoint })
      );
    },
    [closeMapMenu, commandManifestGeneration, generation, submit]
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
      if (manifestStatusRef.current !== "ready" || !selectedEntity || entityKind(selectedEntity) !== "asset") {
        closeMapMenu();
        return;
      }
      dismissCommandForm();
      setMapMenu({
        x: info.x,
        y: info.y,
        lat: info.lat,
        lng: info.lng,
        ...(generation === undefined ? {} : { generation })
      });
    },
    [generation, selectedEntity, selectedEntityId, closeMapMenu, dismissCommandForm]
  );

  return {
    mapMenu:
      commandManifestStatus === "ready" && (mapMenu === null || mapMenu.generation === generation) ? mapMenu : null,
    commandForm:
      commandManifestStatus !== "unavailable" &&
      (commandForm === null ||
        (commandForm.manifestGeneration === commandManifestGeneration && commandForm.generation === generation))
        ? commandForm
        : null,
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
