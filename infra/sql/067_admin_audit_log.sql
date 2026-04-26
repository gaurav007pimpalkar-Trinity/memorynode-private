-- Immutable audit trail for control-plane admin routes (/admin/*, /v1/admin/*).

create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request_id text not null,
  admin_fingerprint text not null,
  route text not null,
  method text not null,
  result text not null check (result in ('success', 'failure')),
  status_code integer not null,
  error_code text,
  surface text not null default 'control_plane'
);

create index if not exists admin_audit_log_created_at_idx on admin_audit_log (created_at desc);
create index if not exists admin_audit_log_route_idx on admin_audit_log (route);
create index if not exists admin_audit_log_fingerprint_created_idx on admin_audit_log (admin_fingerprint, created_at desc);
