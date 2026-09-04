import { Callout } from "@blueprintjs/core";
import { mapAreaSquareMeters, type PluginStatus } from "@the-drunken-coder/atlas-sdk";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { createAuthenticatedAtlasClient } from "../../auth/atlas.js";
import { useAtlas } from "../../state/atlas-context.js";
import { Button, IconButton } from "../../ui/primitives/controls.js";
import { CloseIcon } from "../../ui/primitives/icons.js";
import { formatSpatialReason, formatSpatialRetrievalTime } from "../plugins/spatial-format.js";
import type { SpatialOperationRunner } from "../plugins/use-spatial-operation-runner.js";
import { PanelListRow } from "../shared/PanelListRow.js";

const pollingIntervalMs = 10_000;

type PluginReader = {
  list(options?: { signal?: AbortSignal }): Promise<PluginStatus[]>;
};

export type PluginSelection = {
  pluginId: string;
  name: string;
};

export function PluginsPanel({
  selection,
  onSelectionChange,
  reader: suppliedReader,
  spatial
}: {
  selection?: PluginSelection;
  onSelectionChange(selection?: PluginSelection): void;
  reader?: PluginReader;
  spatial?: SpatialOperationRunner;
}) {
  const { config } = useAtlas();
  const reader = useMemo<PluginReader | undefined>(
    () =>
      suppliedReader ??
      (config ? createAuthenticatedAtlasClient(config.atlasBaseUrl, { sync: false }).plugins : undefined),
    [config, suppliedReader]
  );
  const [snapshot, setSnapshot] = useState<PluginStatus[]>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousSelectionRef = useRef(selection?.pluginId);

  const refresh = useCallback(async () => {
    if (!reader || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setRefreshing(true);
    try {
      const next = await reader.list({ signal: controller.signal });
      if (controller.signal.aborted) return;
      setSnapshot(next);
      setError(undefined);
      setActiveIndex((current) => Math.min(current, Math.max(0, next.length - 1)));
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(sanitizeConnectionError(cause));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = undefined;
        setRefreshing(false);
      }
    }
  }, [reader]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = window.setTimeout(() => void poll(), pollingIntervalMs);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      const controller = requestRef.current;
      requestRef.current = undefined;
      controller?.abort();
    };
  }, [refresh]);

  const selectedPlugin = snapshot?.find((plugin) => plugin.plugin_id === selection?.pluginId);
  const selectedTargetOperation =
    selectedPlugin && spatial?.target?.pluginId === selectedPlugin.plugin_id
      ? selectedPlugin.operations.find(
          (operation) =>
            operation.operation_id === spatial.target?.operationId && operation.interaction?.kind === "map_area"
        )
      : undefined;
  useEffect(() => {
    if (selection && snapshot && !selectedPlugin) {
      onSelectionChange(undefined);
      spatial?.closeTarget();
    }
  }, [onSelectionChange, selectedPlugin, selection, snapshot, spatial]);

  useEffect(() => {
    if (!spatial?.target || !selectedPlugin || spatial.target.pluginId !== selectedPlugin.plugin_id) return;
    if (selectedPlugin.status !== "available") return;
    if (!selectedTargetOperation) {
      spatial.closeTarget();
      return;
    }
    spatial.refreshTarget({
      pluginId: selectedPlugin.plugin_id,
      pluginName: selectedPlugin.display_name ?? selectedPlugin.plugin_id,
      operationId: selectedTargetOperation.operation_id,
      operationName: selectedTargetOperation.display_name
    });
  }, [selectedPlugin, selectedTargetOperation, spatial]);

  useLayoutEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = selection?.pluginId;
    if (selection || !previous) return;
    const frame = requestAnimationFrame(() => rowRefs.current.get(previous)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selection]);

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!snapshot?.length) return;
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(snapshot.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = snapshot.length - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    rowRefs.current.get(snapshot[next].plugin_id)?.focus();
  };

  if (selectedPlugin) {
    return spatial?.target?.pluginId === selectedPlugin.plugin_id &&
      selectedPlugin.status === "available" &&
      selectedTargetOperation &&
      spatial ? (
      <SpatialOperationControls spatial={spatial} discoveryError={error} />
    ) : (
      <PluginDetail plugin={selectedPlugin} spatial={spatial} discoveryError={error} />
    );
  }

  return (
    <section className="plugins-panel entity-browser" aria-label="Plugins">
      <div className="entity-list__summary plugin-browser__summary">
        <span aria-live="polite">
          {snapshot ? `${snapshot.length} configured` : refreshing ? "Checking plugins" : "Status unavailable"}
        </span>
        <Button variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error ? (
        <Callout className="banner banner--error" intent="danger" icon={null} compact role="alert">
          <strong>{snapshot ? "Refresh failed. Showing the last check." : "Plugin status unavailable."}</strong>
          <span>{error}</span>
        </Callout>
      ) : null}

      {!snapshot ? (
        <div className="panel__empty" role="status">
          {refreshing ? "Loading Plugin status…" : "No Plugin status is available."}
        </div>
      ) : snapshot.length === 0 ? (
        <div className="panel__empty">No Plugins are configured.</div>
      ) : (
        <ul className="entity-list" aria-label="Configured Plugins">
          {snapshot.map((plugin, index) => (
            <li key={plugin.plugin_id}>
              <PanelListRow
                ref={(node) => {
                  if (node) rowRefs.current.set(plugin.plugin_id, node);
                  else rowRefs.current.delete(plugin.plugin_id);
                }}
                title={plugin.display_name ?? plugin.plugin_id}
                meta={`${formatStatus(plugin, error !== undefined)} · ${operationSummary(plugin)}`}
                indicatorColor={statusColor(plugin.status, error !== undefined)}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => {
                  setActiveIndex(index);
                  onSelectionChange({ pluginId: plugin.plugin_id, name: plugin.display_name ?? plugin.plugin_id });
                }}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => moveFocus(event, index)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PluginDetail({
  plugin,
  spatial,
  discoveryError
}: {
  plugin: PluginStatus;
  spatial?: SpatialOperationRunner;
  discoveryError?: string;
}) {
  const operations = plugin.operations.filter((operation) => operation.interaction?.kind === "map_area");
  return (
    <div className="plugin-detail" aria-label={plugin.display_name ?? plugin.plugin_id}>
      <div className="plugin-detail__summary">
        <span
          className="plugin-detail__status-dot"
          style={{ background: statusColor(plugin.status, discoveryError !== undefined) }}
          aria-hidden
        />
        <span>{`${formatStatus(plugin, discoveryError !== undefined)} · ${operationSummary(plugin)}`}</span>
      </div>

      {discoveryError ? <PluginDiscoveryError error={discoveryError} /> : null}
      {plugin.status !== "available" ? (
        <Callout className="banner banner--error" intent="danger" icon={null} compact role="status">
          <strong>Plugin unavailable</strong>
          <span>{plugin.reason_code ? formatSpatialReason(plugin.reason_code) : "The plugin is not ready."}</span>
        </Callout>
      ) : operations.length === 0 ? (
        <div className="panel__empty">This plugin has no map area operations.</div>
      ) : (
        <ul className="entity-list plugin-operation-list" aria-label="Operations">
          {operations.map((operation) => (
            <li key={operation.operation_id}>
              <PanelListRow
                title={operation.display_name}
                meta={`Map area · ${formatTimeout(operation.timeout_ms)}`}
                indicatorColor="var(--accent)"
                disabled={discoveryError !== undefined}
                onClick={() =>
                  spatial?.selectTarget({
                    pluginId: plugin.plugin_id,
                    pluginName: plugin.display_name ?? plugin.plugin_id,
                    operationId: operation.operation_id,
                    operationName: operation.display_name
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SpatialOperationControls({
  spatial,
  discoveryError
}: {
  spatial: SpatialOperationRunner;
  discoveryError?: string;
}) {
  const area = spatial.area;
  const result = spatial.result;
  const featureCount = result?.features.length ?? 0;
  const busy = spatial.status === "loading" || spatial.status === "drawing";
  const statusUnknown = discoveryError !== undefined;

  return (
    <div className="plugin-operation" aria-label={spatial.target?.operationName} data-spatial-operation>
      {discoveryError ? <PluginDiscoveryError error={discoveryError} /> : null}
      <div className="plugin-operation__area">
        <div className="plugin-operation__area-heading">
          <strong>{area ? "Selected area" : "Area"}</strong>
          {area ? <span>{formatAreaSize(area)} km²</span> : <span>No area selected</span>}
          {area || result ? (
            <IconButton label="Clear selected area and results" onClick={spatial.clear}>
              <CloseIcon size={13} />
            </IconButton>
          ) : null}
        </div>
        {area ? <div className="plugin-operation__bounds">{formatBounds(area)}</div> : null}
        <div className="plugin-operation__actions">
          {area ? (
            <Button variant="primary" disabled={busy || statusUnknown} onClick={() => void spatial.search()}>
              Search
            </Button>
          ) : null}
          <Button
            variant={area ? "default" : "primary"}
            disabled={busy || statusUnknown}
            onClick={spatial.beginDrawing}
          >
            {area ? "Redraw" : "Draw area"}
          </Button>
          <Button aria-label="Use current view" disabled={busy || statusUnknown} onClick={spatial.useCurrentView}>
            Current view
          </Button>
        </div>
      </div>

      {spatial.status === "drawing" ? (
        <Callout
          className="banner banner--info plugin-operation__notice"
          intent="primary"
          icon={null}
          compact
          role="status"
        >
          <span>Drag on the map. Escape cancels.</span>
          <Button variant="ghost" onClick={spatial.cancel}>
            Cancel
          </Button>
        </Callout>
      ) : null}
      {spatial.status === "loading" ? (
        <Callout
          className="banner banner--info plugin-operation__notice"
          intent="primary"
          icon={null}
          compact
          role="status"
        >
          <span>{spatial.stale ? "Searching. Previous results remain visible." : "Searching selected area."}</span>
          <Button variant="ghost" onClick={spatial.cancel}>
            Cancel
          </Button>
        </Callout>
      ) : null}
      {spatial.error ? (
        <Callout
          className="banner banner--error plugin-operation__notice"
          intent="danger"
          icon={null}
          compact
          role="alert"
        >
          <span>
            <strong>Source error</strong> {spatial.error}
          </span>
          {area ? (
            <Button variant="ghost" onClick={() => void spatial.retry()}>
              Retry
            </Button>
          ) : null}
        </Callout>
      ) : null}

      {result ? (
        <div className="plugin-operation__result-summary" aria-live="polite">
          <span>{`${featureCount} result${featureCount === 1 ? "" : "s"}`}</span>
          {spatial.stale ? <span>stale</span> : <span>{formatSpatialRetrievalTime(result.retrieved_at)}</span>}
          {result.truncation ? <span>Truncated: {formatSpatialReason(result.truncation.reason)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatAreaSize(area: { west: number; south: number; east: number; north: number }): string {
  return (mapAreaSquareMeters(area) / 1_000_000).toFixed(2);
}

function formatBounds(area: { west: number; south: number; east: number; north: number }): string {
  return `${area.south.toFixed(5)}, ${area.west.toFixed(5)} to ${area.north.toFixed(5)}, ${area.east.toFixed(5)}`;
}

function formatStatus(plugin: PluginStatus, stale = false): string {
  const status = plugin.reason_code ? `${plugin.status}: ${formatSpatialReason(plugin.reason_code)}` : plugin.status;
  return stale ? `status unknown (last check: ${status})` : status;
}

function operationSummary(plugin: PluginStatus): string {
  const count = plugin.operations.length;
  return `${count} operation${count === 1 ? "" : "s"}`;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs >= 1000 ? `${timeoutMs / 1000}s timeout` : `${timeoutMs}ms timeout`;
}

function statusColor(status: PluginStatus["status"], stale = false): string {
  if (stale) return "var(--warning)";
  if (status === "available") return "var(--success)";
  if (status === "unavailable") return "var(--error)";
  return "var(--warning)";
}

function PluginDiscoveryError({ error }: { error: string }) {
  return (
    <Callout className="banner banner--error" intent="danger" icon={null} compact role="alert">
      <strong>Refresh failed. Showing the last check.</strong>
      <span>{error}</span>
    </Callout>
  );
}
