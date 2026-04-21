import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HostedBrandedDeps } from "../adapters/hosted.js";
import { registerMemoryFamily } from "./groups/memory.js";
import { registerGroup5HostedTools } from "./groups/group5Hosted.js";
import { registerGroup6HostedTools } from "./groups/group6Hosted.js";
import { registerP1HostedTools } from "./groups/p1Hosted.js";
import { registerProfileFamily } from "./groups/profile.js";
import { registerSearchFamily } from "./groups/search.js";

/** Canonical noun_verb tool names enforced by `lint/validateToolNames.ts` (legacy aliases excluded). */
export const HOSTED_CANONICAL_TOOL_NAMES = [
  "memory_save",
  "memory_forget",
  "memory_forget_confirm",
  "memory_get",
  "memory_delete",
  "memory_list",
  "memory_conversation_save",
  "search",
  "context_pack",
  "ingest_dispatch",
  "identity_get",
  "eval_run",
  "usage_today",
  "audit_log_list",
  "billing_get",
  "billing_checkout_create",
  "billing_portal_create",
  "connector_settings_get",
  "connector_settings_update",
] as const;

export type HostedCanonicalToolName = (typeof HOSTED_CANONICAL_TOOL_NAMES)[number];

/** Registers hosted Streamable MCP tools + backward-compatible aliases (see docs/PLAN.md §1.1). */
export function registerAllHostedTools(server: McpServer, deps: HostedBrandedDeps): void {
  registerMemoryFamily(server, deps);
  registerSearchFamily(server, deps);
  registerProfileFamily(server, deps);
  registerP1HostedTools(server, deps);
  registerGroup5HostedTools(server, deps);
  registerGroup6HostedTools(server, deps);
}

/** Default registry entrypoint — expands as stdio and other transports migrate here. */
export function registerAllTools(server: McpServer, deps: HostedBrandedDeps): void {
  registerAllHostedTools(server, deps);
}
