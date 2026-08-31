import { Callout } from "@blueprintjs/core";
import { AtlasAPIError, AtlasClient, type PluginStatus } from "@the-drunken-coder/atlas-sdk";
import { type KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { useAtlas } from "../../state/atlas-context.js";
import { Button, IconButton } from "../../ui/primitives/controls.js";
import { CloseIcon } from "../../ui/primitives/icons.js";
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
      (config
        ? new AtlasClient({ baseUrl: config.atlasBaseUrl, credentials: "include", sync: false }).plugins
        : undefined),
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
    setError(undefined);
    try {
      const next = await reader.list({ signal: controller.signal });
      if (controller.signal.aborted) return;
      setSnapshot(next);
      setActiveIndex((current) => Math.min(current, Math.max(0, next.length - 1)));
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof AtlasAPIError && cause.status === 401) {
        window.dispatchEvent(new Event("atlas-auth-expired"));
      }
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
  useEffect(() => {
    if (selection && snapshot && !selectedPlugin) {
      onSelectionChange(undefined);
      spatial?.closeTarget();
    }
  }, [onSelectionChange, selectedPlugin, selection, snapshot, spatial]);

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
    return spatial?.target?.pluginId === selectedPlugin.plugin_id && spatial ? (
      <SpatialOperationControls spatial={spatial} />
    ) : (
      <PluginDetail plugin={selectedPlugin} spatial={spatial} />
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
                meta={`${formatStatus(plugin)} · ${operationSummary(plugin)}`}
                indicatorColor={statusColor(plugin.status)}
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

function PluginDetail({ plugin, spatial }: { plugin: PluginStatus; spatial?: SpatialOperationRunner }) {
  const operations = plugin.operations.filter((operation) => operation.interaction?.kind === "map_area");
  return (
    <div className="plugin-detail" aria-label={plugin.display_name ?? plugin.plugin_id}>
      <div className="plugin-detail__summary">
        <span className="plugin-detail__status-dot" style={{ background: statusColor(plugin.status) }} aria-hidden />
        <span>{`${formatStatus(plugin)} · ${operationSummary(plugin)}`}</span>
      </div>

      {plugin.status !== "available" ? (
        <Callout className="banner banner--error" intent="danger" icon={null} compact role="status">
          <strong>Plugin unavailable</strong>
          <span>{plugin.reason_code ? formatReason(plugin.reason_code) : "The plugin is not ready."}</span>
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

function SpatialOperationControls({ spatial }: { spatial: SpatialOperationRunner }) {
  const area = spatial.area;
  const result = spatial.result;
  const featureCount = result?.features.length ?? 0;
  const busy = spatial.status === "loading" || spatial.status === "drawing";

  return (
    <div className="plugin-operation" aria-label={spatial.target?.operationName}>
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
            <Button variant="primary" disabled={busy} onClick={() => void spatial.search()}>
              Search
            </Button>
          ) : null}
          <Button variant={area ? "default" : "primary"} disabled={busy} onClick={spatial.beginDrawing}>
            {area ? "Redraw" : "Draw area"}
          </Button>
          <Button aria-label="Use current view" disabled={busy} onClick={spatial.useCurrentView}>
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
          {spatial.stale ? <span>stale</span> : <span>{formatRetrievedAt(result.retrieved_at)}</span>}
          {result.truncation ? <span>Truncated: {formatReason(result.truncation.reason)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatAreaSize(area: { west: number; south: number; east: number; north: number }): string {
  const earthRadiusMeters = 6_371_008.8;
  const middleLatitude = ((area.south + area.north) / 2) * (Math.PI / 180);
  const width = earthRadiusMeters * Math.cos(middleLatitude) * (area.east - area.west) * (Math.PI / 180);
  const height = earthRadiusMeters * (area.north - area.south) * (Math.PI / 180);
  return ((width * height) / 1_000_000).toFixed(2);
}

function formatBounds(area: { west: number; south: number; east: number; north: number }): string {
  return `${area.south.toFixed(5)}, ${area.west.toFixed(5)} to ${area.north.toFixed(5)}, ${area.east.toFixed(5)}`;
}

function formatRetrievedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function formatStatus(plugin: PluginStatus): string {
  return plugin.reason_code ? `${plugin.status}: ${formatReason(plugin.reason_code)}` : plugin.status;
}

function operationSummary(plugin: PluginStatus): string {
  const count = plugin.operations.length;
  return `${count} operation${count === 1 ? "" : "s"}`;
}

function formatTimeout(timeoutMs: number): string {
  return timeoutMs >= 1000 ? `${timeoutMs / 1000}s timeout` : `${timeoutMs}ms timeout`;
}

function statusColor(status: PluginStatus["status"]): string {
  if (status === "available") return "var(--success)";
  if (status === "unavailable") return "var(--error)";
  return "var(--warning)";
}
