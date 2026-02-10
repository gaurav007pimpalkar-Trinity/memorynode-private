/**
 * Minimal MemoryNode adapter usable with LangChain-style prompt assembly.
 * No LangChain dependency required.
 */

export class MemoryNodeContextAdapter {
  constructor({ baseUrl, apiKey, namespace = "default", topK = 5 }) {
    if (!baseUrl) throw new Error("baseUrl is required");
    if (!apiKey) throw new Error("apiKey is required");
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.namespace = namespace;
    this.topK = topK;
  }

  async getContext({ userId, query }) {
    if (!userId) throw new Error("userId is required");
    if (!query) throw new Error("query is required");
    const res = await fetch(new URL("/v1/context", this.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        user_id: userId,
        namespace: this.namespace,
        query,
        top_k: this.topK,
      }),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }
    if (!res.ok) {
      const code = json?.error?.code ?? "UNKNOWN";
      const message = json?.error?.message ?? text.slice(0, 200);
      throw new Error(`MemoryNode context failed (${res.status}) ${code}: ${message}`);
    }
    return json;
  }

  async buildAugmentedPrompt({ userId, question }) {
    const context = await this.getContext({ userId, query: question });
    const contextText = context?.context_text ?? "";
    return {
      prompt: [
        "You are a helpful assistant. Use memory context when relevant.",
        "",
        "Memory context:",
        contextText || "<none>",
        "",
        `Question: ${question}`,
      ].join("\n"),
      citations: context?.citations ?? [],
      rawContext: context,
    };
  }
}
