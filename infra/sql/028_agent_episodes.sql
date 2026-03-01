-- Agent/tool event log for temporal recall. No analytics; minimal schema.
-- Phase: Agent-Native upgrade (028).
--
-- session_id: NOT NULL to avoid index fragmentation on (workspace_id, session_id, created_at desc).
-- RLS: current_workspace() enforces workspace isolation when JWT has workspace_id (e.g. dashboard).
-- API key (service_role) requests: workspace isolation enforced in handler (workspace_id from auth on insert/list).
create table if not exists agent_episodes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id text,
  session_id text not null,
  event_type text not null check (event_type in ('tool_call', 'tool_result', 'agent_step', 'observation')),
  tool_name text,
  input_summary text,
  output_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_episodes_workspace_session_created_idx
  on agent_episodes (workspace_id, session_id, created_at desc);

-- RLS: workspace isolation. service_role = API key path (handler enforces workspace_id). current_workspace() = JWT path.
alter table agent_episodes enable row level security;
drop policy if exists agent_episodes_sel on agent_episodes;
create policy agent_episodes_sel on agent_episodes for select
  using (auth.role() = 'service_role' or workspace_id = current_workspace());
drop policy if exists agent_episodes_ins on agent_episodes;
create policy agent_episodes_ins on agent_episodes for insert
  with check (auth.role() = 'service_role' or workspace_id = current_workspace());
