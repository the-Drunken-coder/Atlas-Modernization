import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EntityResource, TaskResource } from "../../../atlas_sdk/src/index.js";
import { fetchAppConfig, type AppConfig } from "../app/config.js";
import type { CommandCatalog } from "../atlas/command-model.js";
import { createSdkDataSource, type AtlasDataSource, type CommandSubmission, type ConnectionHealth } from "../atlas/data-source.js";
import type { UiGeometry } from "../atlas/geometry.js";
import { applyWatchEvent, emptySnapshot, snapshotFromDataset, type AtlasSnapshot } from "../atlas/store.js";

export type AtlasStatus = "loading" | "ready" | "error";

export type AtlasContextValue = {
  status: AtlasStatus;
  error?: string;
  config?: AppConfig;
  snapshot: AtlasSnapshot;
  catalog?: CommandCatalog;
  health: ConnectionHealth;
  submitCommand: (submission: CommandSubmission, credential: string) => Promise<TaskResource>;
  updateGeometry: (entityId: string, geometry: UiGeometry, ifMatchVersion?: number) => Promise<EntityResource>;
};

const AtlasContext = createContext<AtlasContextValue | null>(null);

const DEFAULT_HEALTH: ConnectionHealth = { running: false, healthy: false, degraded: false };

export type AtlasProviderProps = {
  children: ReactNode;
  loadConfig?: () => Promise<AppConfig>;
  createDataSource?: (config: AppConfig) => AtlasDataSource;
};

export function AtlasStaticProvider({ children, value }: { children: ReactNode; value: AtlasContextValue }) {
  return <AtlasContext.Provider value={value}>{children}</AtlasContext.Provider>;
}

export function AtlasProvider({ children, loadConfig = fetchAppConfig, createDataSource = createSdkDataSource }: AtlasProviderProps) {
  const [status, setStatus] = useState<AtlasStatus>("loading");
  const [error, setError] = useState<string>();
  const [config, setConfig] = useState<AppConfig>();
  const [catalog, setCatalog] = useState<CommandCatalog>();
  const [snapshot, setSnapshot] = useState<AtlasSnapshot>(emptySnapshot);
  const [health, setHealth] = useState<ConnectionHealth>(DEFAULT_HEALTH);
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
    };

    (async () => {
      try {
        const resolvedConfig = await loadConfig();
        if (cancelled) return;
        setConfig(resolvedConfig);

        const dataSource = createDataSource(resolvedConfig);
        dataSourceRef.current = dataSource;

        const dataset = await dataSource.loadSnapshot();
        if (cancelled) return;
        setSnapshot(snapshotFromDataset(dataset.entities, dataset.tasks));

        const loadedCatalog = await dataSource.loadCommandCatalog().catch(() => undefined);
        if (cancelled) return;
        if (loadedCatalog) setCatalog(loadedCatalog);

        unsubscribe = dataSource.watch((event) => {
          setSnapshot((current) => applyWatchEvent(current, event));
        });

        await dataSource.start();
        if (cancelled) return;
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
      cleanup();
    };
  }, [loadConfig, createDataSource]);

  const value = useMemo<AtlasContextValue>(
    () => ({
      status,
      error,
      config,
      snapshot,
      catalog,
      health,
      submitCommand: async (submission, credential) => {
        const dataSource = dataSourceRef.current;
        if (!dataSource) return Promise.reject(new Error("Atlas data source is not ready"));
        const task = await dataSource.submitCommand(submission, credential);
        setSnapshot((current) => ({ ...current, tasks: { ...current.tasks, [task.task_id]: task } }));
        return task;
      },
      updateGeometry: async (entityId, geometry, ifMatchVersion) => {
        const dataSource = dataSourceRef.current;
        if (!dataSource) return Promise.reject(new Error("Atlas data source is not ready"));
        const entity = await dataSource.updateGeometry(entityId, geometry, ifMatchVersion);
        setSnapshot((current) => ({ ...current, entities: { ...current.entities, [entity.entity_id]: entity } }));
        return entity;
      }
    }),
    [status, error, config, snapshot, catalog, health]
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
