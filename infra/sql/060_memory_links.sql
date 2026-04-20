-- Graph-lite: typed directed links between memories (strict caps enforced in API).

create table if not exists public.memory_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  from_memory_id uuid not null references public.memories (id) on delete cascade,
  to_memory_id uuid not null references public.memories (id) on delete cascade,
  link_type text not null,
  created_at timestamptz not null default now(),
  constraint memory_links_no_self check (from_memory_id <> to_memory_id),
  constraint memory_links_unique_edge unique (workspace_id, from_memory_id, to_memory_id, link_type)
);

create index if not exists memory_links_from_idx
  on public.memory_links (workspace_id, from_memory_id);

create index if not exists memory_links_to_idx
  on public.memory_links (workspace_id, to_memory_id);

comment on table public.memory_links is
  'Optional typed edges between memories (related_to, about_ticket, same_topic).';

alter table public.memory_links enable row level security;

drop policy if exists memory_links_service_all on public.memory_links;
drop policy if exists memory_links_sel on public.memory_links;
drop policy if exists memory_links_mod on public.memory_links;

create policy memory_links_sel on public.memory_links
  for select using (auth.role() = 'service_role' or workspace_id = current_workspace());

create policy memory_links_mod on public.memory_links
  for all using (auth.role() = 'service_role' or workspace_id = current_workspace())
  with check (auth.role() = 'service_role' or workspace_id = current_workspace());
