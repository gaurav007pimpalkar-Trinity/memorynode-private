-- Phase 1/2 migration: introduce explicit memory ownership.
-- Memory owner is required (owner_id + owner_type); workspace_id remains optional organizer.

alter table if exists memories
  add column if not exists owner_id text;

alter table if exists memories
  add column if not exists owner_type text;

alter table if exists memory_chunks
  add column if not exists owner_id text;

alter table if exists memory_chunks
  add column if not exists owner_type text;

update memories
set
  owner_id = coalesce(owner_id, user_id),
  owner_type = coalesce(owner_type, 'user')
where owner_id is null or owner_type is null;

update memory_chunks
set
  owner_id = coalesce(owner_id, user_id),
  owner_type = coalesce(owner_type, 'user')
where owner_id is null or owner_type is null;

alter table if exists memories
  alter column owner_id set not null;

alter table if exists memories
  alter column owner_type set not null;

alter table if exists memory_chunks
  alter column owner_id set not null;

alter table if exists memory_chunks
  alter column owner_type set not null;

alter table if exists memories
  add constraint memories_owner_type_check
  check (owner_type in ('user', 'team', 'app'))
  not valid;

alter table if exists memory_chunks
  add constraint memory_chunks_owner_type_check
  check (owner_type in ('user', 'team', 'app'))
  not valid;

alter table if exists memories
  validate constraint memories_owner_type_check;

alter table if exists memory_chunks
  validate constraint memory_chunks_owner_type_check;

create index if not exists memories_workspace_owner_namespace_idx
  on memories (workspace_id, owner_id, owner_type, namespace);

create index if not exists memory_chunks_workspace_owner_namespace_idx
  on memory_chunks (workspace_id, owner_id, owner_type, namespace);
