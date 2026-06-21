import { createRoot } from "react-dom/client";
import "../ui/tokens.css";
import "../ui/console.css";
import { AppRoutes } from "./routes.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root is missing");
}

createRoot(container).render(<AppRoutes />);
