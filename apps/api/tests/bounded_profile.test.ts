import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchBoundedContextProfile } from "../src/profile/boundedProfile.js";
import type { AuthContext } from "../src/auth.js";
import type { ListOutcome } from "../src/handlers/memories.js";

const emptyList: ListOutcome = {
  results: [],
  total: 0,
  page: 1,
  page_size: 20,
  has_more: false,
};

function makeSupabase(profile: unknown): SupabaseClient {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: { profile }, error: null }),
      })),
    })),
  } as unknown as SupabaseClient;
}

describe("fetchBoundedContextProfile", () => {
  it("returns empty summary slices when profile.summary lists are missing", async () => {
    const performList = vi.fn(async () => ({ ...emptyList }));
    const auth = { workspaceId: "00000000-0000-4000-8000-000000000001" } as AuthContext;
    const supabase = makeSupabase({ summary: {} });
    const out = await fetchBoundedContextProfile(performList, auth, supabase, {
      user_id: "u1",
      namespace: "ns",
    });
    expect(out.pinned_facts).toEqual([]);
    expect(out.recent_notes).toEqual([]);
    expect(out.preferences).toEqual([]);
    expect(performList).toHaveBeenCalled();
  });

  it("ignores non-array top_facts / top_preferences without throwing", async () => {
    const performList = vi.fn(async () => ({ ...emptyList }));
    const auth = { workspaceId: "00000000-0000-4000-8000-000000000002" } as AuthContext;
    const supabase = makeSupabase({
      summary: { top_facts: "not-array" as unknown as string[], top_preferences: null as unknown as string[] },
    });
    const out = await fetchBoundedContextProfile(performList, auth, supabase, {
      user_id: "u1",
      namespace: "ns",
    });
    expect(out.pinned_facts).toEqual([]);
    expect(out.preferences).toEqual([]);
  });

  it("merges string facts from profile summary with pinned list rows", async () => {
    const performList = vi.fn(async () => ({
      results: [
        {
          id: "m1",
          user_id: "u1",
          namespace: "ns",
          text: "Pinned line",
          metadata: {},
          created_at: "2026-01-02T00:00:00.000Z",
          memory_type: "pin",
          source_memory_id: null,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
      has_more: false,
    }));
    const auth = { workspaceId: "00000000-0000-4000-8000-000000000003" } as AuthContext;
    const supabase = makeSupabase({
      summary: { top_facts: ["Synth fact one"], top_preferences: [] },
    });
    const out = await fetchBoundedContextProfile(performList, auth, supabase, {
      user_id: "u1",
      namespace: "ns",
    });
    expect(out.pinned_facts.some((r) => r.memory_id === "profile-fact-1")).toBe(true);
    expect(out.pinned_facts.some((r) => r.text.includes("Pinned line"))).toBe(true);
  });
});
