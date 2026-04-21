import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { FounderApp } from "./FounderApp";
import { getAppSurface, isFounderPath } from "./appSurface";
import "./tailwind-entry.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

const surface = getAppSurface();
if (surface === "app" && !isFounderPath(window.location.pathname)) {
  window.history.replaceState({}, "", "/founder");
}
if (surface === "console" && isFounderPath(window.location.pathname)) {
  window.history.replaceState({}, "", "/");
}

createRoot(root).render(
  <React.StrictMode>
    {surface === "app" ? (
      <FounderApp />
    ) : (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )}
  </React.StrictMode>,
);
