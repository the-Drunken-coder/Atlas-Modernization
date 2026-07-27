import type { EntityResource } from "@the-drunken-coder/atlas-sdk";
import { lazy, Suspense, useCallback, useMemo, useReducer } from "react";
import { entityKind } from "../atlas/entities.js";
import { countsByKind, getEntity } from "../atlas/selectors.js";
import { useAtlas } from "../state/atlas-context.js";
import { initialSidebarState, type ListKind, listForKind, sidebarReducer } from "../state/selection.js";
import { ConnectionBadge } from "../ui/ConnectionBadge.js";
import { AppShell } from "../ui/layout/AppShell.js";
import { SidebarPanel } from "../ui/layout/SidebarPanel.js";
import { SidebarRail } from "../ui/layout/SidebarRail.js";
import type { MapCameraCommand } from "../ui/map/interaction/map-camera.js";
import { buildMapSources } from "../ui/map/rendering/map-sources.js";
import type { MapReticleTarget } from "../ui/map/view/MapView.js";
import { Button } from "../ui/primitives/controls.js";
import { CommandForm } from "./commands/CommandForm.js";
import { MapCommandMenu } from "./MapCommandMenu.js";
import { MapConsolePanel, panelTitle } from "./MapConsolePanel.js";
import { MapSourcePicker } from "./MapSourcePicker.js";
import { useCommandFlow } from "./useCommandFlow.js";
import { useEditSession } from "./useEditSession.js";
import { useMapSourceSelection } from "./useMapSourceSelection.js";

const MapView = lazy(() => import("../ui/map/view/MapView.js").then((module) => ({ default: module.MapView })));

export function MapConsole() {
  const atlas = useAtlas();
  const { snapshot, catalog } = atlas;
  const [sidebar, dispatch] = useReducer(sidebarReducer, initialSidebarState);

  const selection = sidebar.selection;
  const selectedEntity = getEntity(snapshot, selection?.id);
  const selectedId = selection?.id;

  const {
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
  } = useCommandFlow({ submitCommand: atlas.submitCommand, catalog, selectedEntity, selectedId });
  const { edit, saving, saveError, startEdit, changeDraft, saveEdit, cancelEdit } = useEditSession({
    updateGeometry: atlas.updateGeometry,
    selectedEntity,
    selectedId
  });
  const { selectedMapSourceId, selectedMapSource, setSelectedMapSourceId, handleMapStyleSwitchError } =
    useMapSourceSelection(atlas.config);

  const sources = useMemo(
    () => buildMapSources(Object.values(snapshot.entities), selectedId),
    [snapshot.entities, selectedId]
  );
  const counts = useMemo(() => countsByKind(snapshot), [snapshot]);
  const focusTarget = useMemo(() => entityReticleTarget(selectedEntity), [selectedEntity]);
  // Camera intent is derived from the sidebar's claim, not the snapshot, so
  // its identity only changes when the user asks to go somewhere.
  const cameraCommand = useMemo<MapCameraCommand | null>(
    () =>
      sidebar.focusRequest
        ? { seq: sidebar.focusRequest.seq, target: { type: "entity", id: sidebar.focusRequest.id } }
        : null,
    [sidebar.focusRequest]
  );

  const selectEntityById = useCallback(
    (id: string) => {
      const entity = snapshot.entities[id];
      if (!entity) return;
      const kind = entityKind(entity);
      if (kind === "other") return;
      dispatch({ type: "selectEntity", kind, id, origin: "map" });
    },
    [snapshot.entities]
  );

  if (atlas.status === "loading") {
    return (
      <div className="app-loading">
        <span>Connecting to Atlas Core…</span>
      </div>
    );
  }
  if (atlas.status === "error") {
    return (
      <div className="app-error" role="alert">
        <span>Could not connect to Atlas Core.</span>
        <code>{atlas.error}</code>
        <Button variant="primary" onClick={atlas.reconnect}>
          Retry connection
        </Button>
      </div>
    );
  }
  if (!atlas.config) {
    return (
      <div className="app-error">
        <span>Command interface configuration is unavailable.</span>
      </div>
    );
  }
  if (atlas.config.mapSources.length === 0) {
    return (
      <div className="app-error">
        <span>No map sources are configured.</span>
      </div>
    );
  }

  const activeList: ListKind | null =
    sidebar.view.mode === "list" ? sidebar.view.list : selection ? listForKind(selection.kind) : null;
  const mapSourcePickerValue = selectedMapSource?.id ?? selectedMapSourceId ?? atlas.config.defaultMapSourceId;

  return (
    <>
      <AppShell
        collapsed={sidebar.collapsed}
        rail={
          <SidebarRail
            collapsed={sidebar.collapsed}
            activeList={activeList}
            counts={counts}
            onSelectList={(list) => dispatch({ type: "openList", list })}
            onToggleCollapsed={() => dispatch({ type: "toggleCollapsed" })}
          />
        }
        panel={
          <SidebarPanel
            title={panelTitle(sidebar, selection?.kind)}
            onBack={sidebar.view.mode === "inspector" ? () => dispatch({ type: "back" }) : undefined}
            onCollapse={() => dispatch({ type: "setCollapsed", collapsed: true })}
          >
            <MapConsolePanel
              snapshot={snapshot}
              sidebar={sidebar}
              selectedEntity={selectedEntity}
              catalog={catalog}
              edit={edit}
              saving={saving}
              saveError={saveError}
              onSelectEntity={(entity) => {
                const kind = entityKind(entity);
                if (kind === "other") return;
                dispatch({ type: "selectEntity", kind, id: entity.entity_id, origin: "sidebar" });
              }}
              onPickCommand={pickSidebarCommand}
              onStartEdit={startEdit}
              onChangeDraft={changeDraft}
              onSaveEdit={() => void saveEdit()}
              onCancelEdit={cancelEdit}
            />
          </SidebarPanel>
        }
        map={
          <>
            <div className="map-world-frame">
              <div className="map-stage">
                {selectedMapSource ? (
                  <Suspense
                    fallback={
                      <div className="app-loading" role="status">
                        <span>Loading map workspace…</span>
                      </div>
                    }
                  >
                    <MapView
                      sources={sources}
                      styleId={selectedMapSource.id}
                      style={selectedMapSource.style}
                      selectedId={selectedId}
                      editing={edit ? { geometry: edit.draft, onChange: changeDraft } : undefined}
                      focusTarget={focusTarget}
                      cameraCommand={cameraCommand}
                      onSelectEntity={selectEntityById}
                      onMapContextMenu={onMapContextMenu}
                      onBackgroundClick={() => {
                        closeMapMenu();
                        dispatch({ type: "clearSelection" });
                      }}
                      onStyleSwitchError={handleMapStyleSwitchError}
                    />
                  </Suspense>
                ) : (
                  <div className="app-error" role="alert">
                    <span>The configured default map source is unavailable.</span>
                  </div>
                )}
                <ConnectionBadge health={atlas.health} error={atlas.connectionError} onRetry={atlas.reconnect} />
                <MapSourcePicker
                  sources={atlas.config.mapSources}
                  value={mapSourcePickerValue}
                  onChange={setSelectedMapSourceId}
                />
              </div>
            </div>
          </>
        }
      />

      {mapMenu ? (
        <MapCommandMenu
          menu={mapMenu}
          entity={selectedEntity}
          catalog={catalog}
          onPickCommand={pickMapCommand}
          onClose={closeMapMenu}
        />
      ) : null}

      {submitting && !commandForm ? (
        <div className="banner banner--info" role="status">
          Command submission pending…
        </div>
      ) : null}

      {commandForm && selectedEntity ? (
        <CommandForm
          command={commandForm.availability.command}
          targeting={commandForm.availability.targeting}
          formParameters={commandForm.availability.formParameters}
          mapPoint={commandForm.mapPoint}
          submitting={submitting}
          error={submitError}
          onCancel={dismissCommandForm}
          onSubmit={(parameters) => void submit(commandForm.availability, parameters, commandForm)}
        />
      ) : null}
    </>
  );
}

function entityReticleTarget(entity: EntityResource | undefined): MapReticleTarget | null {
  return entity && entityKind(entity) !== "other" ? { type: "entity", id: entity.entity_id } : null;
}
