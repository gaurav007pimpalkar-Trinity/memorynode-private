/**
 * Persist control-plane admin actions to `admin_audit_log` (see infra/sql/023_admin_audit_log.sql).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

export type AdminAuditResult = "success" | "failure";

function classifyAdminResult(status: number): AdminAuditResult {
  if (status >= 200 && status < 400) return "success";
  return "failure";
}

async function extractJsonErrorCode(response: Response): Promise<string | null> {
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null;
  try {
    const j = (await response.clone().json()) as { error?: { code?: string } };
    const code = j?.error?.code;
    return typeof code === "string" && code.trim().length > 0 ? code.trim() : null;
  } catch {
    return null;
  }
}

export async function insertAdminAuditLog(
  supabase: SupabaseClient,
  fields: {
    request_id: string;
    admin_fingerprint: string;
    route: string;
    method: string;
    response: Response;
    surface?: string;
  },
): Promise<void> {
  const res = fields.response;
  const status = res.status;
  const result = classifyAdminResult(status);
  const error_code = await extractJsonErrorCode(res);

  const row = {
    request_id: fields.request_id,
    admin_fingerprint: fields.admin_fingerprint,
    route: fields.route,
    method: fields.method,
    result,
    status_code: status,
    error_code,
    surface: fields.surface ?? "control_plane",
  };

  const ins = await supabase.from("admin_audit_log").insert(row);
  if (ins.error) {
    logger.error({
      event: "admin_audit_log_insert_error",
      request_id: fields.request_id,
      route: fields.route,
      err: ins.error,
    });
  }
}
