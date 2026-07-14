// Bundle 2: Coding Cache (5 endpoints)
// AST parsing via @babel/parser, LLM inference via Groq (llama-3.3-70b-versatile).

import { Hono } from "hono";
import type { Variables } from "../types";
import { buildDependencyTree, checkSyntax, compressTokens } from "../lib/ast-parser";
import { llmChat, getLLMConfig } from "../lib/llm";

const coding = new Hono<{ Variables: Variables }>();

// ─── /dependency-tree ────────────────────────────────────────────────────────

coding.post("/dependency-tree", async (c) => {
  const body = await c.req.json<{ code?: string; filename?: string }>().catch(() => null);
  if (!body?.code) return c.json({ success: false, error: "'code' field required" }, 400);

  const data = await buildDependencyTree(body.code, body.filename);
  return c.json({ success: true, bundle: "coding_cache", data });
});

// ─── /token-compressor ────────────────────────────────────────────────────────

coding.post("/token-compressor", async (c) => {
  const body = await c.req.json<{ raw_code?: string }>().catch(() => null);
  if (!body?.raw_code) return c.json({ success: false, error: "'raw_code' field required" }, 400);

  const result = compressTokens(body.raw_code);
  return c.json({
    success: true,
    bundle: "coding_cache",
    data: {
      compressed:        result.compressed,
      ratio_pct:         result.ratio,
      original_bytes:    body.raw_code.length,
      compressed_bytes:  result.compressed.length,
    },
  });
});

// ─── /syntax-heartbeat ───────────────────────────────────────────────────────

coding.post("/syntax-heartbeat", async (c) => {
  const body = await c.req.json<{ code?: string }>().catch(() => null);
  if (!body?.code) return c.json({ success: false, error: "'code' field required" }, 400);

  const data = await checkSyntax(body.code);
  return c.json({ success: true, bundle: "coding_cache", data });
});

// ─── /refactor-suggest ───────────────────────────────────────────────────────

coding.post("/refactor-suggest", async (c) => {
  const env = c.get("env");
  const body = await c.req.json<{ code?: string; language?: string }>().catch(() => null);
  if (!body?.code) return c.json({ success: false, error: "'code' field required" }, 400);

  try {
    const content = await llmChat(getLLMConfig(env), {
      temperature: 0.2,
      maxTokens:   1024,
      jsonOutput:  true,
      messages: [
        {
          role:    "system",
          content: "You are a senior software engineer doing code review. Return ONLY valid JSON: " +
            '{"suggestions":[{"type":string,"line_hint":number|null,"description":string,"severity":"low"|"medium"|"high"}],' +
            '"overall_quality":"poor"|"fair"|"good"|"excellent","summary":string}',
        },
        {
          role:    "user",
          content: `Language: ${body.language ?? "typescript"}\n\n${body.code.slice(0, 4000)}`,
        },
      ],
    });
    const data = JSON.parse(content);
    return c.json({ success: true, bundle: "coding_cache", data });
  } catch {
    return c.json({ success: false, error: "LLM inference failed" }, 503);
  }
});

// ─── /security-audit ─────────────────────────────────────────────────────────

coding.post("/security-audit", async (c) => {
  const env = c.get("env");
  const body = await c.req.json<{ code?: string; language?: string }>().catch(() => null);
  if (!body?.code) return c.json({ success: false, error: "'code' field required" }, 400);

  try {
    const content = await llmChat(getLLMConfig(env), {
      temperature: 0.1,
      maxTokens:   1024,
      jsonOutput:  true,
      messages: [
        {
          role:    "system",
          content: "You are a security expert auditing code for vulnerabilities. Return ONLY valid JSON: " +
            '{"vulnerabilities":[{"id":string,"severity":"low"|"medium"|"high"|"critical","title":string,' +
            '"description":string,"line_hint":number|null,"recommendation":string}],' +
            '"risk_score":number,"summary":string}',
        },
        {
          role:    "user",
          content: `Language: ${body.language ?? "typescript"}\n\n${body.code.slice(0, 4000)}`,
        },
      ],
    });
    const data = JSON.parse(content);
    return c.json({ success: true, bundle: "coding_cache", data });
  } catch {
    return c.json({ success: false, error: "LLM inference failed" }, 503);
  }
});

export default coding;
