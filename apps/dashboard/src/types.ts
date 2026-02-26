export type ApiKeyRow = {
  id: string;
  name: string;
  workspace_id: string;
  revoked_at: string | null;
  created_at: string;
  key_prefix?: string;
  key_last4?: string;
  last_used_at?: string | null;
  last_used_ip?: string | null;
};

export type MemoryRow = {
  id: string;
  user_id: string;
  namespace: string;
  text: string;
  metadata: Record<string, unknown>;
  created_at: string;
  score?: number;
  memory_type?: string | null;
  source_memory_id?: string | null;
};

export type UsageRow = {
  day: string;
  writes: number;
  reads: number;
  embeds: number;
  plan?: string;
  limits?: {
    writes: number;
    reads: number;
    embeds: number;
  };
};

export type MemberRow = {
  user_id: string;
  role: string;
  created_at: string;
};

export type InviteRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};
