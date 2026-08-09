import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import { dashboardRoutes } from "./App";
import { ToastProvider } from "./Toast";
import { initTheme } from "./theme";
import { migrateLegacyDashboardHash } from "./dashboard-legacy-routes";

initTheme();
migrateLegacyDashboardHash();

const router = createBrowserRouter(dashboardRoutes);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
