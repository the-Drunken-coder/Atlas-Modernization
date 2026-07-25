import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { Providers } from "./providers.js";

const MapConsole = lazy(() => import("../features/MapConsole.js").then((module) => ({ default: module.MapConsole })));
const replaceBrowserPath = (path: string) => window.history.replaceState(null, "", path);

/**
 * `/map` is the only workspace. `mapElement` and `replacePath` are injectable
 * so the redirect can be tested without the live Atlas data layer.
 */
export function ConsoleRoutes({
  mapElement,
  pathname = window.location.pathname,
  replacePath = replaceBrowserPath
}: {
  mapElement: ReactNode;
  pathname?: string;
  replacePath?: (path: string) => void;
}) {
  useEffect(() => {
    if (pathname !== "/map") replacePath("/map");
  }, [pathname, replacePath]);

  return mapElement;
}

export function AppRoutes() {
  return (
    <Providers>
      <ConsoleRoutes
        mapElement={
          <Suspense fallback={<div className="app-loading">Loading map workspace...</div>}>
            <MapConsole />
          </Suspense>
        }
      />
    </Providers>
  );
}
