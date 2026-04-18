import { z } from "zod";
import { MAX_QUERY_CHARS } from "../limits.js";

/** POST /v1/explain/answer — judge-style answer from caller-supplied context (no automatic search). */
export const ExplainAnswerSchema = z.object({
  question: z.string().min(1, "question is required").max(MAX_QUERY_CHARS, `question exceeds ${MAX_QUERY_CHARS} chars`),
  context: z.string().min(1, "context is required").max(48_000, "context exceeds 48000 chars"),
});

export type ExplainAnswerPayload = z.infer<typeof ExplainAnswerSchema>;
