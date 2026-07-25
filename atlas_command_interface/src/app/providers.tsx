import { type ReactNode, useEffect, useState } from "react";
import { sanitizeConnectionError } from "../atlas/connection-error.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { AuthGate } from "../auth/ui/AuthGate.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { Button } from "../ui/primitives/controls.js";
import { type AppConfig, type CoreConfig, coreConfigFromEnv, fetchAppConfig } from "./config.js";

export type ProvidersProps = {
  children: ReactNode;
  coreConfig?: CoreConfig;
  loadConfig?: () => Promise<AppConfig>;
  createDataSource?: (config: AppConfig) => AtlasDataSource;
};

export function Providers({
  children,
  coreConfig: providedCoreConfig,
  loadConfig = fetchAppConfig,
  createDataSource
}: ProvidersProps) {
  let coreConfig: CoreConfig;
  try {
    coreConfig = providedCoreConfig ?? coreConfigFromEnv(import.meta.env);
  } catch (cause) {
    return (
      <div className="app-error">
        <span>{sanitizeConnectionError(cause)}</span>
      </div>
    );
  }

  return (
    <AuthGate baseUrl={coreConfig.atlasBaseUrl}>
      <AtlasBootstrap loadConfig={loadConfig} createDataSource={createDataSource}>
        {children}
      </AtlasBootstrap>
    </AuthGate>
  );
}

function AtlasBootstrap({
  children,
  loadConfig,
  createDataSource
}: Required<Pick<ProvidersProps, "loadConfig">> & Omit<ProvidersProps, "loadConfig" | "coreConfig">) {
  const [config, setConfig] = useState<AppConfig>();
  const [error, setError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setConfig(undefined);
    setError(undefined);
    void loadConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(sanitizeConnectionError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [loadConfig, loadAttempt]);

  if (error) {
    return (
      <div className="app-error" role="alert">
        <span>Could not load command interface configuration.</span>
        <code>{error}</code>
        <Button
          variant="primary"
          onClick={() => {
            setError(undefined);
            setLoadAttempt((attempt) => attempt + 1);
          }}
        >
          Retry configuration
        </Button>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="app-loading">
        <span>Loading configuration...</span>
      </div>
    );
  }

  return (
    <AtlasProvider config={config} createDataSource={createDataSource}>
      {children}
    </AtlasProvider>
  );
}
