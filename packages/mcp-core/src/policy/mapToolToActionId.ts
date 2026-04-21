import type { McpActionId } from "@memorynodeai/shared";

/**
 * Maps hosted MCP registration names to existing {@link McpActionId} values until policy IDs are renamed (Sprint S7).
 */
export function mapHostedToolToPolicyActionId(
  tool: string,
  memoryAction?: "save" | "forget" | "confirm_forget",
): McpActionId | null {
  switch (tool) {
    case "memory_save":
      return "memory.save";
    case "memory_forget":
      return "memory.forget";
    case "memory_forget_confirm":
      return "memory.confirm_forget";
    case "memory":
      if (memoryAction === "forget") return "memory.forget";
      if (memoryAction === "confirm_forget") return "memory.confirm_forget";
      return "memory.save";
    case "search":
    case "recall":
    case "memory_search":
      return "recall";
    case "context_pack":
    case "context":
    case "memory_context":
      return "context";
    case "identity_get":
    case "whoAmI":
    case "whoami":
      return "whoAmI";
    case "memory_get":
    case "memory_list":
      return "memory.read";
    case "memory_delete":
      return "memory.delete";
    case "memory_conversation_save":
      return "memory.conversation_save";
    case "ingest_dispatch":
      return "ingest.dispatch";
    case "eval_run":
      return "eval.run";
    case "usage_today":
      return "usage.today";
    case "audit_log_list":
      return "audit.log.list";
    case "billing_get":
      return "billing.status";
    case "billing_checkout_create":
      return "billing.checkout.create";
    case "billing_portal_create":
      return "billing.portal.create";
    case "connector_settings_get":
      return "connector.settings.get";
    case "connector_settings_update":
      return "connector.settings.update";
    default:
      return null;
  }
}
