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

// ─── /secret-scanner ─────────────────────────────────────────────────────────

const SECRET_PATTERNS: { type: string; regex: RegExp; severity: "critical" | "high" | "medium" }[] = [
  { type: "PRIVATE_KEY_PEM",        regex: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,                        severity: "critical" },
  { type: "ETHEREUM_PRIVATE_KEY",   regex: /\b(?:0x)?[0-9a-fA-F]{64}\b/,                                               severity: "critical" },
  { type: "AWS_ACCESS_KEY_ID",      regex: /\bAKIA[0-9A-Z]{16}\b/,                                                     severity: "high"     },
  { type: "GITHUB_PAT_CLASSIC",     regex: /\bghp_[A-Za-z0-9]{36}\b/,                                                  severity: "high"     },
  { type: "GITHUB_OAUTH_TOKEN",     regex: /\bgho_[A-Za-z0-9]{36}\b/,                                                  severity: "high"     },
  { type: "GITHUB_APP_TOKEN",       regex: /\bghu_[A-Za-z0-9]{36}\b/,                                                  severity: "high"     },
  { type: "OPENAI_API_KEY",         regex: /\bsk-[A-Za-z0-9]{48}\b/,                                                   severity: "high"     },
  { type: "ANTHROPIC_API_KEY",      regex: /\bsk-ant-[A-Za-z0-9_-]{93,}\b/,                                            severity: "high"     },
  { type: "STRIPE_SECRET_KEY",      regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,}\b/,                                   severity: "high"     },
  { type: "STRIPE_PUBLISHABLE_KEY", regex: /\bpk_(?:live|test)_[0-9a-zA-Z]{24,}\b/,                                   severity: "medium"   },
  { type: "GOOGLE_API_KEY",         regex: /\bAIza[0-9A-Za-z_-]{35}\b/,                                                severity: "high"     },
  { type: "SENDGRID_API_KEY",       regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,                            severity: "high"     },
  { type: "JWT_TOKEN",              regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,      severity: "medium"   },
  { type: "GENERIC_SECRET_ASSIGN",  regex: /(?:secret|password|passwd|pwd)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,          severity: "medium"   },
  { type: "GENERIC_TOKEN_ASSIGN",   regex: /(?:token|api_key|apikey|api-key)\s*[:=]\s*['"`][A-Za-z0-9_\-]{16,}['"`]/i, severity: "medium"   },
  { type: "PRIVATE_KEY_ASSIGN",     regex: /private[_-]?key\s*[:=]\s*['"`][^'"`\s]{20,}['"`]/i,                        severity: "high"     },
];

const SEV_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1 };

coding.post("/secret-scanner", async (c) => {
  const body = await c.req.json<{ code?: string; strict?: boolean }>().catch(() => null);
  if (!body?.code) return c.json({ success: false, error: "'code' field required" }, 400);

  const lines = body.code.split("\n");
  const raw: { type: string; line: number; severity: string; match_hint: string; recommendation: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    for (const { type, regex, severity } of SECRET_PATTERNS) {
      const m = regex.exec(lines[i]);
      if (m) {
        const val = m[0];
        raw.push({
          type,
          line:        i + 1,
          severity,
          match_hint:  val.length > 12 ? val.slice(0, 6) + "..." + val.slice(-4) : val,
          recommendation: "Move to environment variable or secret manager",
        });
      }
    }
  }

  // Deduplicate: keep highest severity per (line, type) pair
  const seen = new Map<string, (typeof raw)[0]>();
  for (const item of raw) {
    const key = `${item.line}:${item.type}`;
    const prev = seen.get(key);
    if (!prev || SEV_RANK[item.severity] > SEV_RANK[prev.severity]) seen.set(key, item);
  }
  const found = [...seen.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

  const maxSev = found.reduce<string | null>(
    (m, x) => m === null || SEV_RANK[x.severity] > SEV_RANK[m] ? x.severity : m, null
  );
  const risk_level =
    maxSev === "critical" ? "CRITICAL" :
    maxSev === "high"     ? "HIGH"     :
    maxSev === "medium"   ? "MEDIUM"   : "NONE";

  return c.json({
    success: true,
    bundle: "coding_cache",
    data: { secrets_found: found, risk_level, total_found: found.length, scanned_lines: lines.length, timestamp: Date.now() },
  });
});

export default coding;
