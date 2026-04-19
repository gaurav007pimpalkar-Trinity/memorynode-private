-- MCP rebuild foundations:
-- - scoped container tag support on API keys
-- - connector sync/capture settings
-- - profile engine snapshots keyed by container tag

alter table if exists api_keys
  add column if not exists scoped_container_tag text null;

create table if not exists connector_capture_settings (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  connector_id text not null,
  sync_enabled boolean not null default true,
  capture_types jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, connector_id)
);

create index if not exists connector_capture_settings_workspace_idx
  on connector_capture_settings (workspace_id, updated_at desc);

create table if not exists memory_profiles (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  container_tag text not null,
  profile jsonb not null default '{}'::jsonb,
  confidence double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, container_tag)
);

create index if not exists memory_profiles_workspace_updated_idx
  on memory_profiles (workspace_id, updated_at desc);
