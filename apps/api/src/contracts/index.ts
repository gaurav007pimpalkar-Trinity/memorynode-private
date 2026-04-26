/**
 * Contract layer: Zod schemas (Option A source of truth) and parse helper.
 * Phase 5. OpenAPI is derived from these schemas.
 */

export { parseWithSchema, type ParseResult } from "./validate.js";
export {
  OWNER_TYPES,
  OwnerTypeSchema,
  OwnerTypeInputSchema,
  type OwnerType,
  normalizeOwnerIdentity,
  type OwnerIdentity,
  type OwnerIdentityInput,
  ENTITY_TYPES,
  EntityTypeSchema,
  type EntityType,
} from "./entity.js";
export {
  MemoryInsertSchema,
  type MemoryInsertPayload,
  type ChunkProfile,
  CHUNK_PROFILES,
  chunkParamsForProfile,
} from "./memories.js";
export {
  ConversationInsertSchema,
  type ConversationInsertPayload,
  formatConversationForStorage,
} from "./conversation.js";
export { ProfilePinsPatchSchema, type ProfilePinsPatchPayload } from "./profilePins.js";
export { IngestPayloadSchema, type IngestPayload } from "./ingest.js";
export {
  MEMORY_LINK_TYPES,
  MemoryLinkCreateSchema,
  type MemoryLinkType,
  type MemoryLinkCreatePayload,
} from "./memoryLinks.js";
export { MemoryWebhookIngestSchema, type MemoryWebhookIngestPayload } from "./memoryWebhook.js";
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
  DashboardBootstrapSchema,
  DashboardCreateWorkspaceSchema,
  DashboardCreateApiKeySchema,
  DashboardRevokeApiKeySchema,
  DashboardCreateInviteSchema,
  DashboardRevokeInviteSchema,
  DashboardUpdateMemberRoleSchema,
  DashboardRemoveMemberSchema,
  type DashboardBootstrapPayload,
  type DashboardCreateWorkspacePayload,
  type DashboardCreateApiKeyPayload,
  type DashboardRevokeApiKeyPayload,
  type DashboardCreateInvitePayload,
  type DashboardRevokeInvitePayload,
  type DashboardUpdateMemberRolePayload,
  type DashboardRemoveMemberPayload,
} from "./dashboardOps.js";
export {
  CAPTURE_TYPE_KEYS,
  CaptureTypesSchema,
  ConnectorSettingPatchSchema,
  type CaptureTypeKey,
  type ConnectorSettingPatchPayload,
} from "./connectorSettings.js";
