import { useEffect, useState, type ReactNode } from "react";
import { AuthGate } from "../auth/ui/AuthGate.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { fetchAppConfig, type AppConfig } from "./config.js";

export function Providers({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void fetchAppConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="app-loading">
        <span>{error}</span>
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
      <AtlasProvider config={config}>{children}</AtlasProvider>
    </AuthGate>
  );
}
