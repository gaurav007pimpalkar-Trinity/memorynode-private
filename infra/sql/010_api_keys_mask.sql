-- Add key preview fields for masked listing
alter table if exists api_keys
  add column if not exists key_prefix text,
  add column if not exists key_last4 text;

-- Backfill existing keys with placeholders (cannot recover real key)
update api_keys
set key_prefix = coalesce(key_prefix, 'mn_live'),
    key_last4 = coalesce(key_last4, substr(id::text, 1, 4))
where key_prefix is null or key_last4 is null;
