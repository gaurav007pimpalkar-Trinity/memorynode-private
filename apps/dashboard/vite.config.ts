import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const dashboardDir = path.dirname(fileURLToPath(import.meta.url));

function requireApiBaseInProd() {
  return {
    name: "require-api-base-prod",
    config(_, { mode }) {
      if (mode === "production") {
        const loaded = loadEnv(mode, dashboardDir, "VITE_");
        const base = (process.env.VITE_API_BASE_URL ?? loaded.VITE_API_BASE_URL)?.trim();
        const isLocalhost = base && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base);
        if (!base || isLocalhost) {
          throw new Error(
            "Production build requires VITE_API_BASE_URL to be set and non-localhost. " +
              "Set it in the environment, or copy apps/dashboard/.env.production.example to apps/dashboard/.env.production and fill the URL.",
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [requireApiBaseInProd(), react()],
  server: {
    port: 4173,
  },
});
