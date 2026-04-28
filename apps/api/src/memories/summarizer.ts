export type ConversationSummary = {
  summary: string;
  facts: string[];
  preferences: string[];
  open_loops: string[];
};

type RuntimeConfig = {
  apiKey: string;
  model: string;
};

const runtimeConfig: RuntimeConfig = {
  apiKey: "",
  model: "gpt-4o-mini",
};

const FALLBACK_SUMMARY: ConversationSummary = {
  summary: "",
  facts: [],
  preferences: [],
  open_loops: [],
};

export function setConversationSummarizerConfig(config: {
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

function clip(s: string, max = 500): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}...`;
}

function normalizeList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    out.push(clip(t, 220));
    if (out.length >= maxItems) break;
  }
  return out;
}

function coerceSummary(input: unknown): ConversationSummary | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? clip(obj.summary, 1200) : "";
  return {
    summary,
    facts: normalizeList(obj.facts, 12),
    preferences: normalizeList(obj.preferences, 12),
    open_loops: normalizeList(obj.open_loops, 12),
  };
}

export async function summarizeConversation(input: {
  messages: { role: "user" | "assistant"; content: string }[];
}): Promise<ConversationSummary> {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  if (messages.length === 0) return FALLBACK_SUMMARY;
  if (!runtimeConfig.apiKey) return FALLBACK_SUMMARY;

  const compactMessages = messages
    .slice(-80)
    .map((m) => ({
      role: m.role,
      content: clip(m.content, 500),
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
        max_tokens: 260,
        messages: [
          {
            role: "system",
            content:
              "Summarize a conversation for long-term memory. Extract durable facts, preferences, and open loops/tasks. " +
              "Avoid repetition and noise. Return STRICT JSON only with keys: summary, facts, preferences, open_loops.",
          },
          {
            role: "user",
            content: JSON.stringify({ messages: compactMessages }),
          },
        ],
      }),
    });
    if (!response.ok) return FALLBACK_SUMMARY;
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const rawJson = extractFirstJsonObject(content);
    if (!rawJson) return FALLBACK_SUMMARY;
    const parsed = JSON.parse(rawJson);
    return coerceSummary(parsed) ?? FALLBACK_SUMMARY;
  } catch {
    return FALLBACK_SUMMARY;
  } finally {
    clearTimeout(timeoutId);
  }
}
