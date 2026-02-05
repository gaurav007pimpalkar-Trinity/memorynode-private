-- Broaden current_workspace() to read user/app metadata claims
create or replace function current_workspace() returns uuid
language plpgsql
stable
as $$
declare
  jwt jsonb;
begin
  jwt := auth.jwt();
  if jwt ? 'workspace_id' then
    return (jwt ->> 'workspace_id')::uuid;
  end if;
  if jwt ? 'user_metadata' and (jwt -> 'user_metadata') ? 'workspace_id' then
    return (jwt -> 'user_metadata' ->> 'workspace_id')::uuid;
  end if;
  if jwt ? 'app_metadata' and (jwt -> 'app_metadata') ? 'workspace_id' then
    return (jwt -> 'app_metadata' ->> 'workspace_id')::uuid;
  end if;
  return null;
end;
$$;
