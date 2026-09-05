import type { CommandCatalog, EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type AppConfig, fetchAppConfig } from "../app/config.js";
import { sanitizeConnectionError } from "../atlas/connection-error.js";
import {
  type AtlasDataSource,
  type CommandSubmission,
  type ConnectionError,
  type ConnectionHealth
} from "../atlas/data-source.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { type AtlasSnapshot, emptySnapshot } from "../atlas/store.js";

export type AtlasStatus = "loading" | "ready" | "error";

export type AtlasContextValue = {
  status: AtlasStatus;
  error?: string;
  connectionError?: ConnectionError;
  config?: AppConfig;
  snapshot: AtlasSnapshot;
  catalog?: CommandCatalog;
  health: ConnectionHealth;
  reconnect: () => void;
  loadEntityDetails?: (entityId: string, signal?: AbortSignal) => Promise<EntityResource>;
  submitCommand: (submission: CommandSubmission) => Promise<TaskResource>;
  updateGeometry: (entityId: string, geometry: UiGeometry, ifMatchVersion?: number) => Promise<EntityResource>;
};

const AtlasContext = createContext<AtlasContextValue | null>(null);

const DEFAULT_HEALTH: ConnectionHealth = { running: false, healthy: false, degraded: false };

export type AtlasProviderProps = {
  children: ReactNode;
  config?: AppConfig;
  loadConfig?: () => Promise<AppConfig>;
  createDataSource?: (config: AppConfig) => AtlasDataSource;
};

export function AtlasStaticProvider({ children, value }: { children: ReactNode; value: AtlasContextValue }) {
  return <AtlasContext.Provider value={value}>{children}</AtlasContext.Provider>;
}

export function AtlasProvider({
  children,
  config: providedConfig,
  loadConfig = fetchAppConfig,
  createDataSource
}: AtlasProviderProps) {
  const [status, setStatus] = useState<AtlasStatus>("loading");
  const [error, setError] = useState<string>();
  const [connectionError, setConnectionError] = useState<ConnectionError>();
  const [config, setConfig] = useState<AppConfig>();
  const [catalog, setCatalog] = useState<CommandCatalog>();
  const [snapshot, setSnapshot] = useState<AtlasSnapshot>(emptySnapshot);
  const [health, setHealth] = useState<ConnectionHealth>(DEFAULT_HEALTH);
  const [entityDetailsAvailable, setEntityDetailsAvailable] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const dataSourceRef = useRef<AtlasDataSource | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let healthTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = undefined;
      }
      unsubscribe?.();
      unsubscribe = undefined;
      dataSourceRef.current?.dispose();
      dataSourceRef.current = undefined;
      if (!cancelled) setEntityDetailsAvailable(false);
    };

    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    setError(undefined);
    setConnectionError(undefined);
    setSnapshot(emptySnapshot());
    setCatalog(undefined);
    setHealth(DEFAULT_HEALTH);
    setEntityDetailsAvailable(false);

    const publishHealth = (next: ConnectionHealth) => {
      if (cancelled) return;
      const error = next.error ? { ...next.error, message: sanitizeConnectionError(next.error.message) } : undefined;
      setHealth(error ? { ...next, error } : next);
      if (error) {
        setConnectionError(error);
        setError(error.message);
      } else if (next.healthy && !next.degraded) {
        setConnectionError(undefined);
        setError(undefined);
      }
    };

    void (async () => {
      try {
        const resolvedConfig = providedConfig ?? (await loadConfig());
        if (cancelled) return;
        setConfig(resolvedConfig);

        const resolvedCreateDataSource =
          createDataSource ?? (await import("../atlas/data-source.js")).createSdkDataSource;
        if (cancelled) return;
        const dataSource = resolvedCreateDataSource(resolvedConfig);
        dataSourceRef.current = dataSource;
        setEntityDetailsAvailable(Boolean(dataSource.loadEntityDetails));

        unsubscribe = dataSource.watch((nextSnapshot) => {
          if (cancelled) return;
          setSnapshot(nextSnapshot);
        });

        // Only a failed connection attempt is recoverable here. Construction,
        // watch registration, and the initial snapshot remain fatal setup errors.
        try {
          await dataSource.start();
        } catch (cause) {
          if (cancelled) return;
          cleanup();
          const message = sanitizeConnectionError(cause);
          const connectionError = { source: "startup" as const, message };
          setError(message);
          setConnectionError(connectionError);
          setHealth((current) => ({ ...current, error: connectionError }));
          setStatus("ready");
          return;
        }
        if (cancelled) return;

        setSnapshot(dataSource.snapshot());

        const loadedCatalog = await dataSource.loadCommandCatalog();
        if (cancelled) return;
        setCatalog(loadedCatalog);

        setStatus("ready");

        if (dataSource.health) {
          const poll = () => {
            const next = dataSource.health?.();
            if (next) publishHealth(next);
          };
          poll();
          healthTimer = setInterval(poll, 3000);
        }
      } catch (cause) {
        if (cancelled) return;
        cleanup();
        const message = sanitizeConnectionError(cause);
        setError(message);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [providedConfig, loadConfig, createDataSource, connectionAttempt]);

  const reconnect = useCallback(() => {
    setStatus((current) => (current === "ready" ? "ready" : "loading"));
    setError(undefined);
    setConnectionError(undefined);
    setHealth(DEFAULT_HEALTH);
    setConnectionAttempt((attempt) => attempt + 1);
  }, []);

  const loadEntityDetails = useCallback(async (entityId: string, signal?: AbortSignal) => {
    const dataSource = dataSourceRef.current;
    if (!dataSource?.loadEntityDetails) throw new Error("Atlas Entity details are unavailable");
    return dataSource.loadEntityDetails(entityId, signal);
  }, []);

  const value = useMemo<AtlasContextValue>(
    () => ({
      status,
      error,
      connectionError,
      config,
      snapshot,
      catalog,
      health,
      reconnect,
      loadEntityDetails: entityDetailsAvailable ? loadEntityDetails : undefined,
      submitCommand: async (submission) => {
        const dataSource = dataSourceRef.current;
        if (!dataSource) throw new Error("Atlas data source is not ready");
        return dataSource.submitCommand(submission);
      },
      updateGeometry: async (entityId, geometry, ifMatchVersion) => {
        const dataSource = dataSourceRef.current;
        if (!dataSource) throw new Error("Atlas data source is not ready");
        return dataSource.updateGeometry(entityId, geometry, ifMatchVersion);
      }
    }),
    [
      status,
      error,
      connectionError,
      config,
      snapshot,
      catalog,
      health,
      reconnect,
      entityDetailsAvailable,
      loadEntityDetails
    ]
  );

  return <AtlasContext.Provider value={value}>{children}</AtlasContext.Provider>;
}

export function useAtlas(): AtlasContextValue {
  const value = useContext(AtlasContext);
  if (!value) {
    throw new Error("useAtlas must be used within an AtlasProvider");
  }
  return value;
}
