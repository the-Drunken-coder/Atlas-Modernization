import { useEffect, useState, type ReactNode } from "react";
import { AuthGate } from "../auth/ui/AuthGate.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { Button } from "../ui/primitives/controls.js";
import { fetchAppConfig, type AppConfig } from "./config.js";

export type ProvidersProps = {
  children: ReactNode;
  loadConfig?: () => Promise<AppConfig>;
  createDataSource?: (config: AppConfig) => AtlasDataSource;
};

export function Providers({ children, loadConfig = fetchAppConfig, createDataSource }: ProvidersProps) {
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
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
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
    <AuthGate baseUrl={config.atlasBaseUrl}>
      <AtlasProvider config={config} createDataSource={createDataSource}>
        {children}
      </AtlasProvider>
    </AuthGate>
  );
}
