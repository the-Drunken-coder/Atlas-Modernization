import { BlueprintProvider } from "@blueprintjs/core";
import { createRoot } from "react-dom/client";
import "@blueprintjs/core/lib/css/blueprint.css";
import "../ui/styles/tokens.css";
import "../ui/styles/layout.css";
import "../ui/styles/components.css";
import "../ui/styles/map.css";
import "../ui/styles/overlays.css";
import { AppRoutes } from "./routes.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root is missing");
}

createRoot(container).render(
  <BlueprintProvider portalClassName="bp6-dark atlas-portal">
    <AppRoutes />
  </BlueprintProvider>
);
