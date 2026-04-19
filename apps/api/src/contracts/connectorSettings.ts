import { z } from "zod";

export const CAPTURE_TYPE_KEYS = [
  "pdf",
  "docx",
  "txt",
  "md",
  "html",
  "csv",
  "tsv",
  "xlsx",
  "pptx",
  "eml",
  "msg",
] as const;

export type CaptureTypeKey = (typeof CAPTURE_TYPE_KEYS)[number];

export const CaptureTypesSchema = z.object({
  pdf: z.boolean().optional(),
  docx: z.boolean().optional(),
  txt: z.boolean().optional(),
  md: z.boolean().optional(),
  html: z.boolean().optional(),
  csv: z.boolean().optional(),
  tsv: z.boolean().optional(),
  xlsx: z.boolean().optional(),
  pptx: z.boolean().optional(),
  eml: z.boolean().optional(),
  msg: z.boolean().optional(),
});

export const ConnectorSettingPatchSchema = z.object({
  connector_id: z.string().min(1).max(120),
  sync_enabled: z.boolean().optional(),
  capture_types: CaptureTypesSchema.optional(),
});

export type ConnectorSettingPatchPayload = z.infer<typeof ConnectorSettingPatchSchema>;
