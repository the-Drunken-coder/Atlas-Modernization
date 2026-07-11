import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EntityResource, TaskResource } from "@the-drunken-coder/atlas-sdk";
import { fetchAppConfig, type AppConfig } from "../app/config.js";
import type { CommandCatalog } from "../atlas/command-model.js";
import { createSdkDataSource, type AtlasDataSource, type CommandSubmission, type ConnectionHealth } from "../atlas/data-source.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { emptySnapshot, type AtlasSnapshot } from "../atlas/store.js";

export type AtlasStatus = "loading" | "ready" | "error";

export type AtlasContextValue = {
  status: AtlasStatus;
  error?: string;
  config?: AppConfig;
  snapshot: AtlasSnapshot;
  catalog?: CommandCatalog;
  health: ConnectionHealth;
  reconnect: () => void;
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

export function AtlasProvider({ children, config: providedConfig, loadConfig = fetchAppConfig, createDataSource = createSdkDataSource }: AtlasProviderProps) {
  const [status, setStatus] = useState<AtlasStatus>("loading");
  const [error, setError] = useState<string>();
  const [config, setConfig] = useState<AppConfig>();
  const [catalog, setCatalog] = useState<CommandCatalog>();
  const [snapshot, setSnapshot] = useState<AtlasSnapshot>(emptySnapshot);
  const [health, setHealth] = useState<ConnectionHealth>(DEFAULT_HEALTH);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const dataSourceRef = useRef<AtlasDataSource | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let catalogGeneration = 0;
    let hasCatalog = false;
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
    };

    setStatus("loading");
    setError(undefined);
    setSnapshot(emptySnapshot());
    setCatalog(undefined);
    setHealth(DEFAULT_HEALTH);

    (async () => {
      try {
        const resolvedConfig = providedConfig ?? (await loadConfig());
        if (cancelled) return;
        setConfig(resolvedConfig);

        const dataSource = createDataSource(resolvedConfig);
        dataSourceRef.current = dataSource;

        unsubscribe = dataSource.watch(
          (nextSnapshot) => {
            if (cancelled) return;
            setSnapshot(nextSnapshot);
          },
          (update) => {
            if (update.status === "pending" || (update.status === "failed" && !hasCatalog)) return;
            catalogGeneration++;
            hasCatalog = update.status === "loaded";
            if (!cancelled) setCatalog(update.status === "loaded" ? update.catalog : undefined);
          }
        );

        await dataSource.start();
        if (cancelled) return;

        setSnapshot(dataSource.snapshot());

        const catalogRequest = ++catalogGeneration;
        const loadedCatalog = await dataSource.loadCommandCatalog().catch(() => undefined);
        if (cancelled) return;
        if (catalogRequest === catalogGeneration) {
          hasCatalog = loadedCatalog !== undefined;
          setCatalog(loadedCatalog);
        }

        setStatus("ready");

        if (dataSource.health) {
          const poll = () => {
            const next = dataSource.health?.();
            if (next) setHealth(next);
          };
          poll();
          healthTimer = setInterval(poll, 3000);
        }
      } catch (cause) {
        if (cancelled) return;
        cleanup();
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      catalogGeneration++;
      cleanup();
    };
  }, [providedConfig, loadConfig, createDataSource, connectionAttempt]);

  const reconnect = useCallback(() => {
    setStatus("loading");
    setError(undefined);
    setConnectionAttempt((attempt) => attempt + 1);
  }, []);

  const value = useMemo<AtlasContextValue>(
    () => ({
      status,
      error,
      config,
      snapshot,
      catalog,
      health,
      reconnect,
      submitCommand: async (submission) => {
        const dataSource = dataSourceRef.current;
        if (!dataSource) return Promise.reject(new Error("Atlas data source is not ready"));
        return dataSource.submitCommand(submission);
      },
      updateGeometry: async (entityId, geometry, ifMatchVersion) => {
        const dataSource = dataSourceRef.current;
        if (!dataSource) return Promise.reject(new Error("Atlas data source is not ready"));
        return dataSource.updateGeometry(entityId, geometry, ifMatchVersion);
      }
    }),
    [status, error, config, snapshot, catalog, health, reconnect]
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
