import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, "..", "src");

const ovBodyPath = path.join(src, "views", "_overviewBody.tsx");
const mlBodyPath = path.join(src, "views", "_memoryLabBody.tsx");

const ovHeader = `import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, userFacingErrorMessage } from "../apiClient";
import { DeveloperNextSteps } from "../DeveloperNextSteps";

`;

const mlHeader = `import { useEffect, useMemo, useState } from "react";
import { Panel } from "../components/Panel";
import type { MemoryRow } from "../types";
import { loadMemoryLabIdentity, persistMemoryLabIdentity } from "../memoryLabIdentity";
import { buildCurlPostJson } from "../apiCurl";
import { apiDelete, apiGet, apiPost, userFacingErrorMessage } from "../apiClient";
import { mapSearchResultsToRows, type MemorySearchRow, type SearchApiResult } from "../memorySearch";

`;

/** Prefix export when body files start with `function ComponentName`. */
function exportComponent(body, componentName) {
  return body.replace(
    new RegExp(`^function ${componentName}\\b`, "m"),
    `export function ${componentName}`,
  );
}

if (fs.existsSync(ovBodyPath)) {
  const ov = exportComponent(fs.readFileSync(ovBodyPath, "utf8"), "OverviewView");
  fs.writeFileSync(path.join(src, "views", "OverviewView.tsx"), ovHeader + ov);
  console.log("assembled OverviewView.tsx");
} else {
  console.warn("assemble_views: skip OverviewView (_overviewBody.tsx missing)");
}

if (fs.existsSync(mlBodyPath)) {
  const ml = exportComponent(fs.readFileSync(mlBodyPath, "utf8"), "MemoryLabView");
  fs.writeFileSync(path.join(src, "views", "MemoryLabView.tsx"), mlHeader + ml);
  console.log("assembled MemoryLabView.tsx");
} else {
  console.warn("assemble_views: skip MemoryLabView (_memoryLabBody.tsx missing)");
}
