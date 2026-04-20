-- MemoryNode initial schema

-- Extensions
create extension if not exists vector;
create extension if not exists pgcrypto;

-- Tables
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan text not null default 'free',
  created_at timestamptz default now(),
  check (plan in ('free','pro','team'))
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  created_at timestamptz default now(),
  revoked_at timestamptz null
);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id text not null,
  namespace text not null default 'default',
  text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists memory_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  memory_id uuid references memories(id) on delete cascade,
  user_id text not null,
  namespace text not null default 'default',
  chunk_index int not null,
  chunk_text text not null,
  embedding vector(1536) not null,
  tsv tsvector generated always as (to_tsvector('english', coalesce(chunk_text, ''))) stored,
  created_at timestamptz default now(),
  unique (memory_id, chunk_index)
);

create table if not exists usage_daily (
  workspace_id uuid references workspaces(id) on delete cascade,
  day date not null,
  writes int not null default 0,
  embeds int not null default 0,
  reads int not null default 0,
  primary key (workspace_id, day)
);

-- Indexes
create index if not exists memory_chunks_embedding_idx
  on memory_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create index if not exists memory_chunks_tsv_idx
  on memory_chunks
  using gin (tsv);

create index if not exists memories_workspace_user_namespace_idx
  on memories (workspace_id, user_id, namespace);

create index if not exists memory_chunks_workspace_user_namespace_idx
  on memory_chunks (workspace_id, user_id, namespace);
