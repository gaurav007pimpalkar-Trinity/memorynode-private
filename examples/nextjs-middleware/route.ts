/**
 * Example Next.js App Router endpoint.
 * Path suggestion: app/api/chat/route.ts
 */
import { fetchMemoryContext, storeChatMessage } from "./memorynode";

const memorynode = {
  baseUrl: process.env.BASE_URL ?? "",
  apiKey: process.env.API_KEY ?? "",
};

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    user_id: string;
    namespace?: string;
    message: string;
  };

  if (!memorynode.baseUrl || !memorynode.apiKey) {
    return new Response(
      JSON.stringify({ error: { code: "CONFIG_ERROR", message: "Missing BASE_URL/API_KEY" } }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  if (!body.user_id || !body.message) {
    return new Response(
      JSON.stringify({ error: { code: "BAD_REQUEST", message: "user_id and message are required" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const namespace = body.namespace ?? "chat-default";

  // 1) Persist user message as memory
  await storeChatMessage(memorynode, {
    userId: body.user_id,
    namespace,
    role: "user",
    content: body.message,
  });

  // 2) Retrieve relevant memory context before LLM call
  const memory = await fetchMemoryContext(memorynode, {
    userId: body.user_id,
    namespace,
    query: body.message,
  });

  // 3) Build prompt for your model provider (OpenAI/Anthropic/etc.)
  const prompt = [
    "You are an assistant with long-term memory.",
    "Use the memory context when relevant.",
    "",
    "Memory context:",
    memory.context_text ?? "<none>",
    "",
    `User message: ${body.message}`,
  ].join("\n");

  // Replace this with a real model call; kept minimal for beta onboarding.
  const assistantReply = `Pseudo answer with memory context length=${(memory.context_text ?? "").length}`;

  // 4) Persist assistant response as memory (optional but recommended)
  await storeChatMessage(memorynode, {
    userId: body.user_id,
    namespace,
    role: "assistant",
    content: assistantReply,
  });

  return new Response(
    JSON.stringify({
      answer: assistantReply,
      prompt_preview: prompt.slice(0, 400),
      citations: memory.citations ?? [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
