import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const routerPath = path.join(root, "apps", "api", "src", "router.ts");
const openapiPath = path.join(root, "docs", "external", "openapi.yaml");

const phase1StaticPaths = [
  "/v1/memories",
  "/v1/search",
  "/v1/context",
  "/v1/context/explain",
  "/v1/usage/today",
  "/v1/dashboard/overview-stats",
  "/v1/import",
  "/v1/connectors/settings",
  "/v1/billing/status",
  "/v1/billing/checkout",
];

function readOrThrow(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

const router = readOrThrow(routerPath);
const openapi = readOrThrow(openapiPath);

const missingInRouter = phase1StaticPaths.filter(
  (endpoint) => !router.includes(`url.pathname === "${endpoint}"`),
);

const missingInOpenApi = phase1StaticPaths.filter((endpoint) => {
  const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const routeRegex = new RegExp(`^\\s{2}${escaped}:\\s*$`, "m");
  return !routeRegex.test(openapi);
});

if (missingInRouter.length > 0 || missingInOpenApi.length > 0) {
  console.error("Phase 1 API surface parity check failed.");
  if (missingInRouter.length > 0) {
    console.error(`- Missing in router: ${missingInRouter.join(", ")}`);
  }
  if (missingInOpenApi.length > 0) {
    console.error(`- Missing in OpenAPI: ${missingInOpenApi.join(", ")}`);
  }
  process.exit(1);
}

console.log("Phase 1 API surface parity check passed.");
