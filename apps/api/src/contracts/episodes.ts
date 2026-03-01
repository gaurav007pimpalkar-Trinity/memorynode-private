/**
 * Zod schemas for agent episodes API. POST /v1/episodes, GET /v1/episodes.
 */

import { z } from "zod";

export const EPISODE_EVENT_TYPES = ["tool_call", "tool_result", "agent_step", "observation"] as const;
export type EpisodeEventType = (typeof EPISODE_EVENT_TYPES)[number];

const MAX_SUMMARY_CHARS = 10_000;
const MAX_SESSION_ID_CHARS = 500;
const DEFAULT_EPISODE_LIMIT = 50;
const MAX_EPISODE_LIMIT = 200;

export const EpisodeInsertSchema = z.object({
  session_id: z.string().min(1, "session_id is required").max(MAX_SESSION_ID_CHARS),
  event_type: z.enum(EPISODE_EVENT_TYPES),
  tool_name: z.string().max(256).optional(),
  input_summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
  output_summary: z.string().max(MAX_SUMMARY_CHARS).optional(),
  user_id: z.string().max(512).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});

export type EpisodeInsertPayload = z.infer<typeof EpisodeInsertSchema>;

export function parseEpisodeListParams(url: URL): {
  session_id: string;
  start_time?: string;
  end_time?: string;
  limit: number;
} {
  const session_id = url.searchParams.get("session_id")?.trim();
  if (!session_id) {
    throw new Error("session_id query parameter is required");
  }
  if (session_id.length > MAX_SESSION_ID_CHARS) {
    throw new Error(`session_id exceeds ${MAX_SESSION_ID_CHARS} characters`);
  }
  const start_time = url.searchParams.get("start_time")?.trim() || undefined;
  const end_time = url.searchParams.get("end_time")?.trim() || undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_EPISODE_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_EPISODE_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_EPISODE_LIMIT;
  return { session_id, start_time, end_time, limit };
}
