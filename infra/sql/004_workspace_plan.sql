-- Add plan to workspaces with enum-like check
alter table workspaces
  add column if not exists plan text not null default 'free'
  check (plan in ('free','pro','team'));

