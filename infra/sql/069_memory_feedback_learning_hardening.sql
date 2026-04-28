-- Hardening for adaptive feedback loop: decay metadata + wider clamp ranges.

alter table if exists public.memory_learning_adjustments
  add column if not exists last_updated_at timestamptz null;

update public.memory_learning_adjustments
set last_updated_at = coalesce(last_updated_at, last_feedback_at, updated_at, created_at)
where last_updated_at is null;

alter table if exists public.memory_learning_adjustments
  drop constraint if exists memory_learning_adjustments_min_score_delta_check;

alter table if exists public.memory_learning_adjustments
  add constraint memory_learning_adjustments_min_score_delta_check
  check (min_score_delta >= -0.2 and min_score_delta <= 0.3);
