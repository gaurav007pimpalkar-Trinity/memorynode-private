-- Per-workspace signing secret for POST /v1/webhooks/memory (Zapier/Make style ingest).

create table if not exists public.memory_ingest_webhooks (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  signing_secret text not null,
  created_at timestamptz not null default now()
);

comment on table public.memory_ingest_webhooks is
  'Holds plaintext signing_secret used to verify X-MN-Webhook-Signature (HMAC-SHA256 of raw body). Rotate by replacing row.';

alter table public.memory_ingest_webhooks enable row level security;

drop policy if exists memory_ingest_webhooks_sel on public.memory_ingest_webhooks;
drop policy if exists memory_ingest_webhooks_mod on public.memory_ingest_webhooks;

create policy memory_ingest_webhooks_sel on public.memory_ingest_webhooks
  for select using (auth.role() = 'service_role' or workspace_id = current_workspace());

create policy memory_ingest_webhooks_mod on public.memory_ingest_webhooks
  for all using (auth.role() = 'service_role' or workspace_id = current_workspace())
  with check (auth.role() = 'service_role' or workspace_id = current_workspace());
