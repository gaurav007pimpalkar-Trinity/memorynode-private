#!/usr/bin/env node
/**
 * Sync a curated subset of this monorepo into the public GitHub repository
 * (remote `memorynode-public` → https://github.com/gaurav007pimpalkar-Trinity/memorynode.git).
 *
 * Usage:
 *   node scripts/sync_public_github_repo.mjs           # clone + copy + git status (no commit/push)
 *   node scripts/sync_public_github_repo.mjs --commit # stage + commit if changed (no push)
 *   node scripts/sync_public_github_repo.mjs --push   # commit + push (requires auth + PUBLIC_SYNC_CONFIRM=1)
 *
 * Manifest: scripts/public_github_mirror.json
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "public_github_mirror.json");

const SUPPORTING_BLOCK =
  /^## ℹ️ Supporting Documentation\n\n[\s\S]*?\n---\n\n/m;

function readManifest() {
  const raw = fs.readFileSync(MANIFEST_PATH, "utf8");
  return JSON.parse(raw);
}

function getPublicRemoteUrl(manifest) {
  try {
    const u = execSync("git remote get-url memorynode-public", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    if (u) return u;
  } catch {
    /* remote missing */
  }
  return manifest.cloneUrl;
}

/**
 * Strip the monorepo-only supporting header and fix links for the standalone public repo layout.
 * @param {string} content
 * @param {string} destPath path inside public repo (e.g. docs/TRUST.md)
 */
function transformPublicDocs(content, destPath) {
  let c = content.replace(SUPPORTING_BLOCK, "");
  if (destPath === "docs/TRUST.md") {
    c = c.replaceAll("](../SECURITY.md)", "](./SECURITY.md)");
    c = c.replaceAll("](../DATA_RETENTION.md)", "](./DATA_RETENTION.md)");
  }
  if (destPath === "docs/DATA_RETENTION.md") {
    c = c.replace(
      "[API usage](./external/API_USAGE.md)",
      "[HTTP API — @memorynodeai/sdk on npm](https://www.npmjs.com/package/@memorynodeai/sdk)",
    );
    c = c.replace(
      "[external README](./external/README.md)",
      "[Repository README](../README.md)",
    );
    c = c.replaceAll("./external/TRUST.md", "./TRUST.md");
    c = c.replace(
      "[external/TRUST.md](./TRUST.md)",
      "[TRUST.md](./TRUST.md)",
    );
  }
  if (destPath === "docs/POSITIONING.md") {
    c = c.replace(
      "See [MCP_SERVER.md](../MCP_SERVER.md).",
      "See the [@memorynodeai/mcp-server package on npm](https://www.npmjs.com/package/@memorynodeai/mcp-server).",
    );
  }
  return c;
}

function transformFile(content, destPath, transform) {
  if (transform === "publicDocs") {
    return transformPublicDocs(content, destPath);
  }
  return content;
}

function copyFile(fromAbs, toAbs, transform, destRel) {
  let body = fs.readFileSync(fromAbs, "utf8");
  body = transformFile(body, destRel, transform);
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.writeFileSync(toAbs, body, "utf8");
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const doCommit = args.has("--commit") || args.has("--push");
  const doPush = args.has("--push");

  if (doPush && process.env.PUBLIC_SYNC_CONFIRM !== "1") {
    console.error(
      "Refusing to push: set PUBLIC_SYNC_CONFIRM=1 to confirm you intend to update the public GitHub repo.",
    );
    process.exit(1);
  }

  const manifest = readManifest();
  const stagingRel = manifest.stagingDir || ".public-github-sync";
  const stagingAbs = path.join(REPO_ROOT, stagingRel);
  const cloneUrl = getPublicRemoteUrl(manifest);

  console.log("Public remote URL:", cloneUrl);
  console.log("Staging directory:", stagingAbs);

  rmrf(stagingAbs);

  execSync(`git clone --depth 1 "${cloneUrl}" "${stagingAbs}"`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });

  for (const entry of manifest.files) {
    const fromAbs = path.join(REPO_ROOT, entry.from);
    const toAbs = path.join(stagingAbs, entry.to);
    if (!fs.existsSync(fromAbs)) {
      console.error("Missing source file:", entry.from);
      process.exit(1);
    }
    copyFile(fromAbs, toAbs, entry.transform, entry.to);
    console.log("Copied", entry.from, "→", entry.to);
  }

  const status = execSync("git status --porcelain", {
    cwd: stagingAbs,
    encoding: "utf8",
  }).trim();

  if (!status) {
    console.log("No changes — public repo already matches manifest.");
    return;
  }

  console.log("\nPending changes:\n", status, "\n");

  if (!doCommit) {
    console.log(
      "Dry run only. Re-run with --commit to create a commit, or --push (and PUBLIC_SYNC_CONFIRM=1) to push.",
    );
    return;
  }

  execSync("git add -A", { cwd: stagingAbs, stdio: "inherit" });
  execSync(
    'git commit -m "chore: sync public mirror from memorynode-private"',
    { cwd: stagingAbs, stdio: "inherit" },
  );

  if (doPush) {
    execSync("git push origin HEAD:main", { cwd: stagingAbs, stdio: "inherit" });
    console.log("Pushed to public repo main.");
  } else {
    console.log("Committed locally in staging. Run with --push + PUBLIC_SYNC_CONFIRM=1 to publish.");
  }
}

main();
