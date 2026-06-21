import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { MapConsole } from "../features/MapConsole.js";
import { Providers } from "./providers.js";

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
        <ConsoleRoutes mapElement={<MapConsole />} />
      </Providers>
    </BrowserRouter>
  );
}
