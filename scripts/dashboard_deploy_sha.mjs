#!/usr/bin/env node
/**
 * Single source for "which commit is this dashboard build?" — used by build + deploy scripts.
 * Order: VITE_BUILD_SHA → GITHUB_SHA → git rev-parse HEAD
 */
import { execSync } from "node:child_process";

export function resolveDashboardDeploySha() {
  const fromVite = (process.env.VITE_BUILD_SHA ?? "").trim();
  if (fromVite) return fromVite;
  const fromGh = (process.env.GITHUB_SHA ?? "").trim();
  if (fromGh) return fromGh;
  try {
    return execSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
