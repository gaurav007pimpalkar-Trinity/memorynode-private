-- Audit log table
create table if not exists api_audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid null,
  api_key_id uuid null,
  route text not null,
  method text not null,
  status int not null,
  bytes_in int not null default 0,
  bytes_out int not null default 0,
  latency_ms int not null default 0,
  ip_hash text not null,
  user_agent text null,
  created_at timestamptz not null default now()
);

create index if not exists api_audit_log_route_idx on api_audit_log(route);
create index if not exists api_audit_log_created_idx on api_audit_log(created_at desc);
