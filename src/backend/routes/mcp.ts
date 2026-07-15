// MCP Server — all 19 endpoints as tools via Streamable HTTP Transport.
// buildMcpServer(env) receives env via parameter; tools close over it.
// Per-request instantiation required for stateless VPS deployments.

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { binance as Binance } from "ccxt";
import type { Variables, Env } from "../types";
import { embed, cosineSimilarity } from "../lib/embeddings";
import { buildDependencyTree, checkSyntax, compressTokens } from "../lib/ast-parser";
import { llmChat, getLLMConfig } from "../lib/llm";

const mcp = new Hono<{ Variables: Variables }>();

const ok  = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (msg: string)   => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true });

// Secret pattern types for the secret-scanner tool
const SECRET_PATTERNS: { type: string; regex: RegExp; severity: string }[] = [
  { type: "PRIVATE_KEY_PEM",        regex: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/,                        severity: "critical" },
  { type: "ETHEREUM_PRIVATE_KEY",   regex: /\b(?:0x)?[0-9a-fA-F]{64}\b/,                                               severity: "critical" },
  { type: "AWS_ACCESS_KEY_ID",      regex: /\bAKIA[0-9A-Z]{16}\b/,                                                     severity: "high"     },
  { type: "GITHUB_PAT",             regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/,                                            severity: "high"     },
  { type: "OPENAI_API_KEY",         regex: /\bsk-(?:proj-|[A-Za-z0-9])[A-Za-z0-9_-]{40,}\b/,                           severity: "high"     },
  { type: "ANTHROPIC_API_KEY",      regex: /\bsk-ant-[A-Za-z0-9_-]{80,}\b/,                                            severity: "high"     },
  { type: "STRIPE_SECRET_KEY",      regex: /\bsk_(?:live|test)_[0-9a-zA-Z]{24,}\b/,                                   severity: "high"     },
  { type: "GOOGLE_API_KEY",         regex: /\bAIza[0-9A-Za-z_-]{35}\b/,                                                severity: "high"     },
  { type: "JWT_TOKEN",              regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,      severity: "medium"   },
  { type: "GENERIC_SECRET_ASSIGN",  regex: /\b\w*(?:secret|password|passwd|pwd)\w*\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,  severity: "medium"   },
  { type: "GENERIC_PASS_ASSIGN",    regex: /\b\w*pass\w*\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,                            severity: "medium"   },
];

function buildMcpServer(env: Env): McpServer {
  const server   = new McpServer({ name: "lobre", version: "1.1.0" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exchange = new (Binance as any)({ enableRateLimit: true }) as InstanceType<typeof Binance>;
  const llm      = getLLMConfig(env);

  // ── Trading Bundle ────────────────────────────────────────────────────────

  server.tool("trading-vitals", "Live BTC/ETH price, 24h change, and volume.", async () => {
    try {
      const [btc, eth] = await Promise.all([exchange.fetchTicker("BTC/USDT"), exchange.fetchTicker("ETH/USDT")]);
      return ok({ btc: { price_usd: btc.last, change_24h_pct: btc.percentage }, eth: { price_usd: eth.last, change_24h_pct: eth.percentage }, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-orderbook-depth", "Orderbook bids/asks, spread, and imbalance for a trading pair.",
    { pair: z.string().optional().default("BTC/USDT") },
    async ({ pair }) => {
      try {
        const ob = await exchange.fetchOrderBook(pair, 20);
        const bestBid = ob.bids[0]?.[0] ?? 0, bestAsk = ob.asks[0]?.[0] ?? 0;
        return ok({ pair, best_bid: bestBid, best_ask: bestAsk, spread_usd: bestAsk - bestBid, bids: ob.bids.slice(0, 5), asks: ob.asks.slice(0, 5) });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("trading-funding-rates", "BTC/ETH/SOL perpetual futures funding rates.", async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const settled = await Promise.allSettled(["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"].map((p) => (exchange as any).fetchFundingRate(p)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rates = settled.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => ({ symbol: r.value.symbol, rate: r.value.fundingRate, rate_pct: `${(r.value.fundingRate * 100).toFixed(4)}%` }));
      return ok({ rates, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-whale-tracker", "Recent large USDC transfers on Base mainnet. On-chain data.", async () => {
    try {
      const res  = await fetch(`${env.BLOCKSCOUT_BASE_URL}/api?module=account&action=tokentx&contractaddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&sort=desc&offset=100&page=1`);
      const json = await res.json() as { status: string; result?: Record<string, string>[] };
      if (json.status !== "1" || !Array.isArray(json.result)) return ok({ large_transfers: [], threshold_usd: 500000 });
      const whales = json.result.filter((tx) => parseInt(tx.value ?? "0") / 1e6 >= 500000).slice(0, 10)
        .map((tx) => ({ hash: tx.hash, from: tx.from, to: tx.to, amount_usdc: parseInt(tx.value ?? "0") / 1e6 }));
      return ok({ large_transfers: whales, threshold_usd: 500000, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-mev-risk-index", "MEV sandwich attack risk score (0–100) for the current Base block.", async () => {
    try {
      const rpcRes = await fetch(env.BASE_RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBlockByNumber", params: ["latest", true], id: 1 }) });
      const { result: block } = await rpcRes.json() as { result: Record<string, unknown> };
      const txs = (block?.transactions ?? []) as Record<string, string>[];
      if (txs.length < 3) return ok({ risk_score: 0, risk_level: "low" });
      const gasPrices = txs.map((tx) => parseInt(tx.gasPrice ?? "0", 16));
      const avg = gasPrices.reduce((a, b) => a + b, 0) / gasPrices.length;
      const highGasRatio = gasPrices.filter((g) => g > avg * 3).length / txs.length;
      const senderCounts: Record<string, number> = {};
      for (const tx of txs) senderCounts[tx.from] = (senderCounts[tx.from] ?? 0) + 1;
      const score = Math.min(100, Math.round((highGasRatio * 60 + Math.max(...Object.values(senderCounts)) / txs.length * 40) * 100));
      return ok({ risk_score: score, risk_level: score < 20 ? "low" : score < 50 ? "medium" : score < 80 ? "high" : "critical", total_txs: txs.length });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-gas-tracker", "Gas prices (slow/standard/fast) for ETH, Base, and Solana.", async () => {
    try {
      const rpc = async (url: string, method: string, params: unknown[] = []) => {
        const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
        return ((await r.json()) as { result: unknown }).result;
      };
      const tryEthRpc = async () => {
        for (const url of ["https://eth.llamarpc.com", "https://cloudflare-eth.com", "https://rpc.ankr.com/eth"]) {
          try { return await rpc(url, "eth_feeHistory", ["0x5", "latest", [10, 50, 90]]); } catch { /* next */ }
        }
        throw new Error("all ETH RPCs failed");
      };
      const [baseRes, ethRes, solRes] = await Promise.allSettled([
        rpc(env.BASE_RPC_URL, "eth_feeHistory", ["0x5", "latest", [10, 50, 90]]),
        tryEthRpc(),
        rpc("https://api.mainnet-beta.solana.com", "getRecentPrioritizationFees", []),
      ]);
      const parseEip1559 = (result: unknown) => {
        if (!result || typeof result !== "object") return null;
        const r = result as { baseFeePerGas?: string[]; reward?: string[][] };
        const baseFees = (r.baseFeePerGas ?? []).map(h => parseInt(h, 16));
        const rewards  = (r.reward ?? []).map(tier => tier.map(h => parseInt(h, 16)));
        const latestBase = baseFees[baseFees.length - 1] ?? 0;
        return { slow: parseFloat(((latestBase + (rewards.at(-1)?.[0] ?? 0)) / 1e9).toFixed(4)), standard: parseFloat(((latestBase + (rewards.at(-1)?.[1] ?? 0)) / 1e9).toFixed(4)), fast: parseFloat(((latestBase + (rewards.at(-1)?.[2] ?? 0)) / 1e9).toFixed(4)), unit: "gwei" };
      };
      const parseSolana = (result: unknown) => {
        if (!Array.isArray(result) || result.length === 0) return null;
        const fees = result.map((r: { prioritizationFee?: number }) => r.prioritizationFee ?? 0).sort((a, b) => a - b);
        return { low: fees[Math.floor(fees.length * 0.1)] ?? 0, medium: fees[Math.floor(fees.length * 0.5)] ?? 0, high: fees[Math.floor(fees.length * 0.9)] ?? 0, unit: "microlamports" };
      };
      return ok({ base: baseRes.status === "fulfilled" ? parseEip1559(baseRes.value) : null, eth: ethRes.status === "fulfilled" ? parseEip1559(ethRes.value) : null, solana: solRes.status === "fulfilled" ? parseSolana(solRes.value) : null, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-token-screener", "Scan tokens by 24h price change and volume. Returns top movers.",
    {
      price_change_min:  z.number().optional().default(5),
      volume_change_min: z.number().optional().default(1_000_000),
      limit:             z.number().optional().default(20),
    },
    async ({ price_change_min, volume_change_min, limit }) => {
      try {
        const res = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=24h&sparkline=false");
        if (!res.ok) return err("upstream unavailable");
        const coins = (await res.json()) as { symbol: string; name: string; current_price: number; price_change_percentage_24h: number; total_volume: number; market_cap: number }[];
        const results = coins
          .filter(c => Math.abs(c.price_change_percentage_24h ?? 0) >= price_change_min && (c.total_volume ?? 0) >= volume_change_min)
          .sort((a, b) => Math.abs(b.price_change_percentage_24h) - Math.abs(a.price_change_percentage_24h))
          .slice(0, Math.min(limit, 50))
          .map(c => ({ symbol: c.symbol.toUpperCase() + "/USD", name: c.name, price: c.current_price, change_24h_pct: parseFloat((c.price_change_percentage_24h ?? 0).toFixed(2)), direction: (c.price_change_percentage_24h ?? 0) >= 0 ? "up" : "down", volume_24h_usd: Math.round(c.total_volume ?? 0) }));
        return ok({ screened: results, count: results.length, timestamp: Date.now() });
      } catch { return err("upstream unavailable"); }
    }
  );

  // ── Coding Bundle ─────────────────────────────────────────────────────────

  server.tool("coding-dependency-tree", "Extract import/export graph from JavaScript or TypeScript source code.",
    { code: z.string(), filename: z.string().optional() },
    async ({ code, filename }) => {
      const data = await buildDependencyTree(code, filename);
      return ok(data);
    }
  );

  server.tool("coding-token-compressor", "Strip comments and whitespace to minimize LLM token usage.",
    { raw_code: z.string() },
    async ({ raw_code }) => ok({ ...compressTokens(raw_code), original_bytes: raw_code.length })
  );

  server.tool("coding-syntax-heartbeat", "Validate JavaScript, TypeScript, or JSX syntax.",
    { code: z.string() },
    async ({ code }) => ok(await checkSyntax(code))
  );

  server.tool("coding-refactor-suggest", "AI-powered refactoring suggestions with severity ratings.",
    { code: z.string(), language: z.string().optional().default("typescript") },
    async ({ code, language }) => {
      try {
        const content = await llmChat(llm, {
          temperature: 0.2, maxTokens: 1024, jsonOutput: true,
          messages: [
            { role: "system", content: 'Return ONLY valid JSON: {"suggestions":[{"type":string,"line_hint":number|null,"description":string,"severity":"low"|"medium"|"high"}],"overall_quality":string}' },
            { role: "user", content: `Language: ${language}\n\n${code.slice(0, 4000)}` },
          ],
        });
        return ok(JSON.parse(content));
      } catch { return err("LLM inference failed"); }
    }
  );

  server.tool("coding-security-audit", "Static security audit — detect SQL injection, XSS, and vulnerability patterns.",
    { code: z.string(), language: z.string().optional().default("typescript") },
    async ({ code, language }) => {
      try {
        const content = await llmChat(llm, {
          temperature: 0.1, maxTokens: 1024, jsonOutput: true,
          messages: [
            { role: "system", content: 'Return ONLY valid JSON: {"vulnerabilities":[{"id":string,"severity":string,"title":string,"description":string,"recommendation":string}],"risk_score":number}' },
            { role: "user", content: `Language: ${language}\n\n${code.slice(0, 4000)}` },
          ],
        });
        return ok(JSON.parse(content));
      } catch { return err("LLM inference failed"); }
    }
  );

  server.tool("coding-secret-scanner", "Detect hardcoded secrets, API keys, and private keys in source code.",
    { code: z.string(), strict: z.boolean().optional().default(false) },
    async ({ code }) => {
      const lines = code.split("\n");
      const seen = new Map<string, { type: string; line: number; severity: string; match_hint: string }>();
      const SEV: Record<string, number> = { critical: 3, high: 2, medium: 1 };
      for (let i = 0; i < lines.length; i++) {
        for (const { type, regex, severity } of SECRET_PATTERNS) {
          const m = regex.exec(lines[i]);
          if (m) {
            const key = `${i + 1}:${type}`;
            const prev = seen.get(key);
            if (!prev || SEV[severity] > SEV[prev.severity]) {
              const val = m[0];
              seen.set(key, { type, line: i + 1, severity, match_hint: val.length > 12 ? val.slice(0, 6) + "..." + val.slice(-4) : val });
            }
          }
        }
      }
      const found = [...seen.values()].sort((a, b) => SEV[b.severity] - SEV[a.severity]);
      const maxSev = found.reduce<string | null>((m, x) => m === null || SEV[x.severity] > SEV[m] ? x.severity : m, null);
      const risk_level = maxSev === "critical" ? "CRITICAL" : maxSev === "high" ? "HIGH" : maxSev === "medium" ? "MEDIUM" : "NONE";
      return ok({ secrets_found: found, risk_level, total_found: found.length, scanned_lines: lines.length, timestamp: Date.now() });
    }
  );

  // ── Analysis Bundle ───────────────────────────────────────────────────────

  server.tool("analysis-sentiment", "Classify text sentiment as positive, negative, or neutral.",
    { text: z.string() },
    async ({ text }) => {
      try {
        const content = await llmChat(llm, {
          temperature: 0.0, maxTokens: 128, jsonOutput: true,
          messages: [
            { role: "system", content: 'Return ONLY valid JSON: {"sentiment":"positive"|"negative"|"neutral","confidence":0.0-1.0,"dominant_emotion":string,"brief_reason":string}' },
            { role: "user", content: text.slice(0, 2000) },
          ],
        });
        const parsed = JSON.parse(content);
        return ok({ sentiment: parsed.sentiment, confidence: parseFloat((Number(parsed.confidence) || 0).toFixed(3)), dominant_emotion: parsed.dominant_emotion ?? null, brief_reason: parsed.brief_reason ?? null, timestamp: Date.now() });
      } catch { return err("LLM inference failed"); }
    }
  );

  server.tool("analysis-heartbeat", "Cosine similarity between two texts using sentence embeddings.",
    { text_a: z.string(), text_b: z.string() },
    async ({ text_a, text_b }) => {
      try {
        const [va, vb] = await Promise.all([embed(text_a), embed(text_b)]);
        const sim = cosineSimilarity(va, vb);
        return ok({ similarity: parseFloat(sim.toFixed(6)), vector_dims: va.length });
      } catch { return err("embedding model unavailable"); }
    }
  );

  server.tool("analysis-entity-extractor", "Extract named entities from unstructured text.",
    { text: z.string() },
    async ({ text }) => {
      try {
        const content = await llmChat(llm, {
          temperature: 0.1, maxTokens: 1024, jsonOutput: true,
          messages: [
            { role: "system", content: 'Return ONLY valid JSON: {"entities":[{"text":string,"type":string,"confidence":string}],"entity_count":number}' },
            { role: "user", content: text.slice(0, 3000) },
          ],
        });
        return ok(JSON.parse(content));
      } catch { return err("LLM inference failed"); }
    }
  );

  server.tool("analysis-context-ranker", "Re-rank text chunks by semantic relevance to a query.",
    { query: z.string(), chunks: z.array(z.string()) },
    async ({ query, chunks }) => {
      try {
        const [qv, ...cvs] = await Promise.all([embed(query), ...chunks.map(embed)]);
        const ranked = chunks
          .map((chunk, i) => ({ index: i, score: parseFloat(cosineSimilarity(qv, cvs[i]).toFixed(6)), chunk }))
          .sort((a, b) => b.score - a.score);
        return ok({ ranked });
      } catch { return err("embedding model unavailable"); }
    }
  );

  server.tool("analysis-bias-detector", "Detect framing bias, sentiment slant, and loaded language in text.",
    { text: z.string() },
    async ({ text }) => {
      try {
        const content = await llmChat(llm, {
          temperature: 0.1, maxTokens: 1024, jsonOutput: true,
          messages: [
            { role: "system", content: 'Return ONLY valid JSON: {"bias_detected":boolean,"bias_types":[],"confidence":string,"bias_score":number,"summary":string}' },
            { role: "user", content: text.slice(0, 3000) },
          ],
        });
        return ok(JSON.parse(content));
      } catch { return err("LLM inference failed"); }
    }
  );

  server.tool("analysis-fact-linkage", "Verify a claim via fact-check database with AI fallback.",
    { claim: z.string(), language: z.string().optional().default("en") },
    async ({ claim, language }) => {
      if (env.GOOGLE_FACTCHECK_API_KEY) {
        try {
          const params = new URLSearchParams({ query: claim.slice(0, 512), languageCode: language, key: env.GOOGLE_FACTCHECK_API_KEY, pageSize: "5" });
          const res = await fetch(`https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`);
          const json = await res.json() as { claims?: unknown[] };
          if (json.claims?.length) return ok({ source: "fact_check_db", claims: json.claims.slice(0, 3) });
        } catch { /* fall through */ }
      }
      try {
        const content = await llmChat(llm, {
          temperature: 0.1, maxTokens: 512, jsonOutput: true,
          messages: [
            { role: "system", content: 'Return ONLY valid JSON: {"assessment":string,"confidence":string,"reasoning":string}' },
            { role: "user", content: `Claim: ${claim.slice(0, 1000)}` },
          ],
        });
        return ok({ source: "ai", ...JSON.parse(content) });
      } catch { return err("LLM inference failed"); }
    }
  );

  return server;
}

mcp.all("/", async (c) => {
  const env       = c.get("env");
  const server    = buildMcpServer(env);
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

export default mcp;
