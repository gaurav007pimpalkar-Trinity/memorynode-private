export type EvolutionDecision = {
  action: "create" | "update" | "merge" | "ignore";
  target_memory_ids: string[];
  new_memory_text?: string;
  reason: string;
  confidence: number;
};

export type MemoryChunk = {
  id: string;
  text: string;
  importance?: number | null;
  timestamp?: string | null;
};

const FALLBACK_EVOLUTION: EvolutionDecision = {
  action: "create",
  target_memory_ids: [],
  new_memory_text: "",
  reason: "fallback",
  confidence: 0.5,
};

const ACTIONS = new Set<EvolutionDecision["action"]>([
  "create",
  "update",
  "merge",
  "ignore",
]);

type RuntimeConfig = {
  apiKey: string;
  model: string;
};

const runtimeConfig: RuntimeConfig = {
  apiKey: "",
  model: "gpt-4o-mini",
};

export function setMemoryEvolutionConfig(config: {
  openaiApiKey?: string;
  model?: string;
}): void {
  const key = typeof config.openaiApiKey === "string" ? config.openaiApiKey.trim() : "";
  if (key) runtimeConfig.apiKey = key;
  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (model) runtimeConfig.model = model;
}

function extractFirstJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

function truncateText(text: string, max = 320): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}...`;
}

function coerceEvolutionDecision(input: unknown, fallbackText: string): EvolutionDecision | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const actionRaw = typeof obj.action === "string" ? obj.action : "";
  if (!ACTIONS.has(actionRaw as EvolutionDecision["action"])) return null;
  const idsRaw = Array.isArray(obj.target_memory_ids) ? obj.target_memory_ids : [];
  const targetMemoryIds = idsRaw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim())
    .slice(0, 12);
  const reason = typeof obj.reason === "string" && obj.reason.trim()
    ? obj.reason.trim().slice(0, 240)
    : "llm";
  const confidenceRaw = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5;
  const newMemoryText = typeof obj.new_memory_text === "string" && obj.new_memory_text.trim().length > 0
    ? obj.new_memory_text.trim().slice(0, 10000)
    : fallbackText;

  return {
    action: actionRaw as EvolutionDecision["action"],
    target_memory_ids: targetMemoryIds,
    new_memory_text: newMemoryText,
    reason,
    confidence,
  };
}

export async function evolveMemory(input: {
  interaction: {
    user: string;
    assistant: string;
  };
  relatedMemories: MemoryChunk[];
}): Promise<EvolutionDecision> {
  const user = (input.interaction.user ?? "").toString().trim();
  const assistant = (input.interaction.assistant ?? "").toString().trim();
  if (!user) {
    return {
      ...FALLBACK_EVOLUTION,
      action: "ignore",
      new_memory_text: "",
      reason: "empty_user_interaction",
    };
  }
  const fallback: EvolutionDecision = {
    ...FALLBACK_EVOLUTION,
    new_memory_text: user,
  };
  if (!runtimeConfig.apiKey) return fallback;

  const related = (input.relatedMemories ?? []).slice(0, 20).map((m) => ({
    id: m.id,
    text: truncateText(m.text ?? ""),
    importance: m.importance ?? null,
    timestamp: m.timestamp ?? null,
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6500);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${runtimeConfig.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: runtimeConfig.model,
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You are Memory Evolution Engine. Decide how memory should evolve after an interaction. " +
              "Detect new facts, preference changes, contradictions, and redundancy. " +
              "Return STRICT JSON only with keys: action, target_memory_ids, new_memory_text, reason, confidence. " +
              "Allowed action values: create, update, merge, ignore. " +
              "target_memory_ids should reference provided memory ids only.",
          },
          {
            role: "user",
            content: JSON.stringify({
              interaction: {
                user: truncateText(user, 2000),
                assistant: truncateText(assistant, 1800),
              },
              related_memories: related,
            }),
          },
        ],
      }),
    });
    if (!response.ok) return fallback;

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const rawJson = extractFirstJsonObject(content);
    if (!rawJson) return fallback;
    const parsed = JSON.parse(rawJson);
    return coerceEvolutionDecision(parsed, user) ?? fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}
