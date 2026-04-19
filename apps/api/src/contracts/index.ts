/**
 * Contract layer: Zod schemas (Option A source of truth) and parse helper.
 * Phase 5. OpenAPI is derived from these schemas.
 */

export { parseWithSchema, type ParseResult } from "./validate.js";
export {
  MemoryInsertSchema,
  type MemoryInsertPayload,
  type ChunkProfile,
  CHUNK_PROFILES,
  chunkParamsForProfile,
} from "./memories.js";
export {
  SearchPayloadSchema,
  type SearchPayload,
  type MemoryType,
  type SearchMode,
  type RetrievalProfile,
  MEMORY_TYPES,
  SEARCH_MODES,
  RETRIEVAL_PROFILES,
} from "./search.js";
export {
  ImportPayloadSchema,
  ImportModeSchema,
  type ImportPayload,
  type ImportMode,
} from "./import.js";
export {
  EvalSetCreateSchema,
  EvalItemCreateSchema,
  EvalRunSchema,
  type EvalSetCreatePayload,
  type EvalItemCreatePayload,
  type EvalRunPayload,
} from "./evals.js";
export { ExplainAnswerSchema, type ExplainAnswerPayload } from "./explain.js";
export {
  CreateWorkspaceSchema,
  CreateApiKeySchema,
  RevokeApiKeySchema,
  type CreateWorkspacePayload,
  type CreateApiKeyPayload,
  type RevokeApiKeyPayload,
} from "./admin.js";
export {
  CAPTURE_TYPE_KEYS,
  CaptureTypesSchema,
  ConnectorSettingPatchSchema,
  type CaptureTypeKey,
  type ConnectorSettingPatchPayload,
} from "./connectorSettings.js";
