// LLM inference helper — Ollama (primary, self-hosted) + Groq (cloud fallback).
// Both expose an OpenAI-compatible /v1/chat/completions endpoint.
// Default model: Qwen2.5-3B-Instruct (GGUF Q4_K_M, ~2 GB RAM) via Ollama.
// Groq fallback: llama-3.3-70b-versatile (requires GROQ_API_KEY in env).

export interface LLMMessage {
  role: "system" | "user";
  content: string;
}

export interface LLMClientConfig {
  baseUrl:    string;   // Ollama: http://localhost:11434
  model:      string;   // e.g. "qwen2.5:3b"
  groqApiKey?: string;  // optional cloud fallback
}

interface ChatOptions {
  messages:    LLMMessage[];
  temperature?: number;
  maxTokens?:  number;
  jsonOutput?: boolean;
}

async function callCompletions(
  baseUrl: string,
  model:   string,
  apiKey:  string,
  opts:    ChatOptions
): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages:   opts.messages,
      temperature: opts.temperature ?? 0.1,
      max_tokens:  opts.maxTokens  ?? 1024,
      ...(opts.jsonOutput && { response_format: { type: "json_object" } }),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status}: ${body}`);
  }

  const data = await res.json() as { choices: { message: { content: string } }[] };
  return data.choices[0]?.message?.content ?? "{}";
}

// Try Ollama first; if it fails and GROQ_API_KEY is set, fall back to Groq cloud.
export async function llmChat(config: LLMClientConfig, opts: ChatOptions): Promise<string> {
  try {
    return await callCompletions(config.baseUrl, config.model, "ollama", opts);
  } catch (primary) {
    if (!config.groqApiKey) throw primary;
    return await callCompletions(
      "https://api.groq.com/openai",
      "llama-3.3-70b-versatile",
      config.groqApiKey,
      opts
    );
  }
}

export function getLLMConfig(env: {
  LLM_BASE_URL: string;
  LLM_MODEL:    string;
  GROQ_API_KEY: string;
}): LLMClientConfig {
  return {
    baseUrl:    env.LLM_BASE_URL,
    model:      env.LLM_MODEL,
    groqApiKey: env.GROQ_API_KEY || undefined,
  };
}
