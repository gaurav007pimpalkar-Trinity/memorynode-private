import { describe, expect, it } from "vitest";
import { HOSTED_CANONICAL_TOOL_NAMES } from "../src/registry/registerAllTools.js";
import {
  CONNECTOR_SETTINGS_GET_DESCRIPTION,
  CONNECTOR_SETTINGS_UPDATE_DESCRIPTION,
} from "../src/registry/groups/group5Hosted.js";
import {
  AUDIT_LOG_LIST_DESCRIPTION,
  BILLING_CHECKOUT_CREATE_DESCRIPTION,
  BILLING_GET_DESCRIPTION,
  BILLING_PORTAL_CREATE_DESCRIPTION,
  USAGE_TODAY_DESCRIPTION,
} from "../src/registry/groups/group6Hosted.js";
import {
  EVAL_RUN_DESCRIPTION,
  INGEST_DISPATCH_DESCRIPTION,
  MEMORY_CONVERSATION_SAVE_DESCRIPTION,
  MEMORY_DELETE_DESCRIPTION,
  MEMORY_GET_DESCRIPTION,
  MEMORY_LIST_DESCRIPTION,
} from "../src/registry/groups/p1Hosted.js";

function assertFourFieldDescription(label: string, desc: string): void {
  expect(desc, label).toMatch(/^WHAT:/m);
  expect(desc, label).toMatch(/^WHEN:/m);
  expect(desc, label).toMatch(/^INSTEAD:/m);
  expect(desc, label).toMatch(/^RETURNS:/m);
}

describe("S5 P1 hosted manifest", () => {
  it("lists every Section 3 Indie P1 canonical tool (excluding search/context_pack aliases-only)", () => {
    expect(HOSTED_CANONICAL_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "memory_save",
        "memory_forget",
        "memory_forget_confirm",
        "memory_get",
        "memory_delete",
        "memory_list",
        "memory_conversation_save",
        "search",
        "context_pack",
        "ingest_dispatch",
        "identity_get",
        "eval_run",
        "usage_today",
        "audit_log_list",
        "billing_get",
        "billing_checkout_create",
        "billing_portal_create",
        "connector_settings_get",
        "connector_settings_update",
      ]),
    );
    expect(HOSTED_CANONICAL_TOOL_NAMES.length).toBe(19);
  });

  it("uses four-field descriptions for new P1 tool registrations", () => {
    assertFourFieldDescription("memory_get", MEMORY_GET_DESCRIPTION);
    assertFourFieldDescription("memory_delete", MEMORY_DELETE_DESCRIPTION);
    assertFourFieldDescription("memory_list", MEMORY_LIST_DESCRIPTION);
    assertFourFieldDescription("memory_conversation_save", MEMORY_CONVERSATION_SAVE_DESCRIPTION);
    assertFourFieldDescription("ingest_dispatch", INGEST_DISPATCH_DESCRIPTION);
    assertFourFieldDescription("eval_run", EVAL_RUN_DESCRIPTION);
    assertFourFieldDescription("usage_today", USAGE_TODAY_DESCRIPTION);
    assertFourFieldDescription("audit_log_list", AUDIT_LOG_LIST_DESCRIPTION);
    assertFourFieldDescription("billing_get", BILLING_GET_DESCRIPTION);
    assertFourFieldDescription("billing_checkout_create", BILLING_CHECKOUT_CREATE_DESCRIPTION);
    assertFourFieldDescription("billing_portal_create", BILLING_PORTAL_CREATE_DESCRIPTION);
    assertFourFieldDescription("connector_settings_get", CONNECTOR_SETTINGS_GET_DESCRIPTION);
    assertFourFieldDescription("connector_settings_update", CONNECTOR_SETTINGS_UPDATE_DESCRIPTION);
  });
});
