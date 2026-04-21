import type { SupabaseClient } from "@supabase/supabase-js";
import type { HostedAuthContext } from "../types/workerBridge.js";

export type ServiceContext = {
  env: unknown;
  supabase: SupabaseClient;
  auth: HostedAuthContext;
  requestId: string;
};
