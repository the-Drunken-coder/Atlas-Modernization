import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Providers } from "./providers.js";

/**
 * Route table. `/map` is the only workspace; `/home` and any unknown path
 * redirect to it. `mapElement` is injectable so later console layers can mount
 * their map experience without changing the app shell.
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

function MapShellPlaceholder() {
  return <main aria-label="Atlas map console" />;
}

export function AppRoutes() {
  return (
    <BrowserRouter>
      <Providers>
        <ConsoleRoutes mapElement={<MapShellPlaceholder />} />
      </Providers>
    </BrowserRouter>
  );
}
