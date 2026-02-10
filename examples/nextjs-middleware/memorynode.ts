type MemoryNodeConfig = {
  baseUrl: string;
  apiKey: string;
};

type ContextResponse = {
  context_text?: string;
  citations?: Array<Record<string, unknown>>;
};

async function callMemoryNode<T>(
  config: MemoryNodeConfig,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(new URL(path, config.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MemoryNode ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function storeChatMessage(
  config: MemoryNodeConfig,
  params: {
    userId: string;
    namespace: string;
    role: "user" | "assistant";
    content: string;
  },
): Promise<void> {
  await callMemoryNode(config, "/v1/memories", {
    user_id: params.userId,
    namespace: params.namespace,
    text: `[${params.role}] ${params.content}`,
    metadata: { source: "nextjs-chat" },
  });
}

export async function fetchMemoryContext(
  config: MemoryNodeConfig,
  params: {
    userId: string;
    namespace: string;
    query: string;
  },
): Promise<ContextResponse> {
  return await callMemoryNode<ContextResponse>(config, "/v1/context", {
    user_id: params.userId,
    namespace: params.namespace,
    query: params.query,
    top_k: 5,
  });
}
