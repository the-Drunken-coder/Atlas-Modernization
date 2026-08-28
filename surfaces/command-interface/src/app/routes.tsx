import { lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Providers } from "./providers.js";

const MapConsole = lazy(() => import("../features/MapConsole.js").then((module) => ({ default: module.MapConsole })));

/**
 * Route table. `/map` is the only real workspace; `/home` and any unknown path
 * redirect to it. `mapElement` is injectable so routing can be tested without
 * the live Atlas data layer.
 */
export function ConsoleRoutes({ mapElement }: { mapElement: ReactNode }) {
  return (
    <Routes>
      <Route path="/map" element={mapElement} />
      <Route path="/home" element={<Navigate to="/map" replace />} />
      <Route path="*" element={<Navigate to="/map" replace />} />
    </Routes>
  );
}

export function AppRoutes() {
  return (
    <BrowserRouter>
      <Providers>
        <ConsoleRoutes
          mapElement={
            <Suspense fallback={<div className="app-loading">Loading map workspace...</div>}>
              <MapConsole />
            </Suspense>
          }
        />
      </Providers>
    </BrowserRouter>
  );
}
