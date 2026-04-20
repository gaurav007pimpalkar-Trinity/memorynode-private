import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, "..", "src", "App.tsx");
const lines = fs.readFileSync(appPath, "utf8").split(/\r?\n/);

/** 1-based inclusive line numbers */
function removeLines(start1, end1) {
  const start0 = start1 - 1;
  const count = end1 - start1 + 1;
  lines.splice(start0, count);
}

// MemoryLabView + RetrievalExplainPayload (must remove before smaller line ranges shift)
removeLines(2190, 3223);
removeLines(861, 1114);
removeLines(818, 829);

fs.writeFileSync(appPath, lines.join("\n"), "utf8");
console.log("stripped App.tsx:", appPath);
