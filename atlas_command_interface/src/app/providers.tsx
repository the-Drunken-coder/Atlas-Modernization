import type { ReactNode } from "react";
import { AtlasProvider } from "../state/atlas-context.js";

export function Providers({ children }: { children: ReactNode }) {
  return <AtlasProvider>{children}</AtlasProvider>;
}
