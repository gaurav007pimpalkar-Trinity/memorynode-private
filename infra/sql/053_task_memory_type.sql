-- Optional memory_type value: task (actionable items / todos).
-- RPCs accept arbitrary values in p_memory_types text[]; no function change required.

comment on column memories.memory_type is
  'Optional type tag: fact, preference, event, note, task. NULL means untyped (legacy).';
