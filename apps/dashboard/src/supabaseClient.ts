import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

const missing: string[] = [];
if (!supabaseUrl) missing.push("VITE_SUPABASE_URL");
if (!supabaseAnonKey) missing.push("VITE_SUPABASE_ANON_KEY");

export const supabaseEnvError =
  missing.length > 0 ? `Missing required env: ${missing.join(", ")}` : null;

export const supabase: SupabaseClient =
  supabaseEnvError
    ? (null as unknown as SupabaseClient)
    : createClient(supabaseUrl!, supabaseAnonKey!, {
        auth: {
          persistSession: true,
          detectSessionInUrl: true,
        },
      });
