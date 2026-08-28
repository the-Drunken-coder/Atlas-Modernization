import { AtlasAPIError, AtlasClient, type PluginStatus } from "@the-drunken-coder/atlas-sdk";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sanitizeConnectionError } from "../../atlas/connection-error.js";
import { useAtlas } from "../../state/atlas-context.js";

const pollingIntervalMs = 10_000;

type PluginReader = {
  list(options?: { signal?: AbortSignal }): Promise<PluginStatus[]>;
};

export function PluginsPanel({ reader: suppliedReader }: { reader?: PluginReader }) {
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
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);

  const refresh = useCallback(async () => {
    if (!reader) return;
    requestRef.current?.abort();
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
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollingIntervalMs);
    return () => {
      window.clearInterval(timer);
      requestRef.current?.abort();
    };
  }, [refresh]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (!snapshot?.length) return;
    let next = index;
    if (event.key === "ArrowDown") next = Math.min(snapshot.length - 1, index + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = snapshot.length - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    rowRefs.current[next]?.focus();
  };

  return (
    <section className="plugins-panel" aria-label="Plugin status">
      <div className="plugins-panel__toolbar">
        <span aria-live="polite">
          {snapshot ? `${snapshot.length} configured` : refreshing ? "Checking plugins" : "Status unavailable"}
        </span>
        <button className="plugins-panel__refresh" type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="plugins-panel__error" role="alert">
          <strong>{snapshot ? "Refresh failed. Showing last successful check." : "Plugin status unavailable."}</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {!snapshot ? (
        <div className="panel__empty" role="status">
          {refreshing ? "Loading Plugin status…" : "No Plugin status is available."}
        </div>
      ) : snapshot.length === 0 ? (
        <div className="panel__empty">No Plugins are configured.</div>
      ) : (
        <div className="plugin-table" role="table" aria-label="Configured Plugins">
          <div className="plugin-table__header" role="row">
            <span role="columnheader">State</span>
            <span role="columnheader">Plugin</span>
            <span role="columnheader">Operations</span>
            <span role="columnheader">Checked</span>
          </div>
          <div role="rowgroup">
            {snapshot.map((plugin, index) => (
              <div
                key={plugin.plugin_id}
                ref={(node) => {
                  rowRefs.current[index] = node;
                }}
                className="plugin-row"
                data-status={plugin.status}
                role="row"
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => moveFocus(event, index)}
              >
                <div className="plugin-row__state" role="cell" data-label="State">
                  <span className="plugin-state-marker" aria-hidden />
                  <strong>{plugin.status}</strong>
                  {plugin.reason_code ? <span>{formatReason(plugin.reason_code)}</span> : null}
                </div>
                <div className="plugin-row__identity" role="cell" data-label="Plugin">
                  <strong>{plugin.display_name ?? plugin.plugin_id}</strong>
                  <code>{plugin.plugin_id}</code>
                  {plugin.tool_asset_id ? <code title={plugin.tool_asset_id}>Asset {plugin.tool_asset_id}</code> : null}
                </div>
                <div className="plugin-row__operations" role="cell" data-label="Operations">
                  {plugin.operations.length === 0 ? (
                    <span>None</span>
                  ) : (
                    plugin.operations.map((operation) => (
                      <span
                        key={operation.operation_id}
                        title={`${operation.display_name}, ${operation.timeout_ms} ms`}
                      >
                        {operation.operation_id}
                      </span>
                    ))
                  )}
                </div>
                <time role="cell" data-label="Checked" dateTime={plugin.checked_at ?? undefined}>
                  {formatCheckedAt(plugin.checked_at)}
                </time>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function formatReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function formatCheckedAt(value: string | null): string {
  if (!value) return "Waiting";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
