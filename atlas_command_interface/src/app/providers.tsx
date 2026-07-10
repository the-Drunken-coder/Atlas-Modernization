import type { ReactNode } from "react";
import { AuthGate } from "../auth/ui/AuthGate.js";
import type { AtlasDataSource } from "../atlas/data-source.js";
import { AtlasProvider } from "../state/atlas-context.js";
import { coreConfigFromEnv, fetchAppConfig, type AppConfig, type CoreConfig } from "./config.js";

export type ProvidersProps = {
  children: ReactNode;
  coreConfig?: CoreConfig;
  loadConfig?: () => Promise<AppConfig>;
  createDataSource?: (config: AppConfig) => AtlasDataSource;
};

export function Providers({ children, coreConfig: providedCoreConfig, loadConfig = fetchAppConfig, createDataSource }: ProvidersProps) {
  let coreConfig: CoreConfig;
  try {
    coreConfig = providedCoreConfig ?? coreConfigFromEnv(import.meta.env);
  } catch (cause) {
    return (
      <div className="app-error">
        <span>{cause instanceof Error ? cause.message : String(cause)}</span>
      </div>
    );
  }

  return (
    <AuthGate baseUrl={coreConfig.atlasBaseUrl}>
      <AtlasProvider loadConfig={loadConfig} createDataSource={createDataSource}>
        {children}
      </AtlasProvider>
    </AuthGate>
  );
}
