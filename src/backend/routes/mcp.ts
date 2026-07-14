// MCP Server — all 15 endpoints as tools via Streamable HTTP Transport.
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

function buildMcpServer(env: Env): McpServer {
  const server   = new McpServer({ name: "lobre", version: "1.0.0" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exchange = new (Binance as any)({ enableRateLimit: true }) as InstanceType<typeof Binance>;
  const llm      = getLLMConfig(env);

  // ── Trading Bundle ────────────────────────────────────────────────────────

  server.tool("trading-vitals", "Live BTC/ETH price, 24 h change, volume from Binance", async () => {
    try {
      const [btc, eth] = await Promise.all([exchange.fetchTicker("BTC/USDT"), exchange.fetchTicker("ETH/USDT")]);
      return ok({ btc: { price_usd: btc.last, change_24h_pct: btc.percentage }, eth: { price_usd: eth.last, change_24h_pct: eth.percentage }, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-orderbook-depth", "Binance orderbook bids/asks, spread and imbalance",
    { pair: z.string().optional().default("BTC/USDT") },
    async ({ pair }) => {
      try {
        const ob = await exchange.fetchOrderBook(pair, 20);
        const bestBid = ob.bids[0]?.[0] ?? 0, bestAsk = ob.asks[0]?.[0] ?? 0;
        return ok({ pair, best_bid: bestBid, best_ask: bestAsk, spread_usd: bestAsk - bestBid, bids: ob.bids.slice(0, 5), asks: ob.asks.slice(0, 5) });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("trading-funding-rates", "BTC/ETH/SOL perpetual futures funding rates from Binance", async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const settled = await Promise.allSettled(["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"].map((p) => (exchange as any).fetchFundingRate(p)));
      const rates = settled.filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
        .map((r) => ({ symbol: r.value.symbol, rate: r.value.fundingRate, rate_pct: `${(r.value.fundingRate * 100).toFixed(4)}%` }));
      return ok({ rates, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-whale-tracker", "Recent large USDC transfers on Base (>$500K) via Blockscout", async () => {
    try {
      const res  = await fetch(`${env.BLOCKSCOUT_BASE_URL}/api?module=account&action=tokentx&contractaddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&sort=desc&offset=100&page=1`);
      const json = await res.json() as { status: string; result?: Record<string, string>[] };
      if (json.status !== "1" || !Array.isArray(json.result)) return ok({ large_transfers: [], threshold_usd: 500000 });
      const whales = json.result.filter((tx) => parseInt(tx.value ?? "0") / 1e6 >= 500000).slice(0, 10)
        .map((tx) => ({ hash: tx.hash, from: tx.from, to: tx.to, amount_usdc: parseInt(tx.value ?? "0") / 1e6 }));
      return ok({ large_transfers: whales, threshold_usd: 500000, timestamp: Date.now() });
    } catch { return err("upstream unavailable"); }
  });

  server.tool("trading-mev-risk-index", "MEV sandwich attack risk score for current Base block", async () => {
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

  // ── Coding Bundle ─────────────────────────────────────────────────────────

  server.tool("coding-dependency-tree", "Extract import/export graph from source code",
    { code: z.string(), filename: z.string().optional() },
    async ({ code, filename }) => {
      const data = await buildDependencyTree(code, filename);
      return ok(data);
    }
  );

  server.tool("coding-token-compressor", "Strip comments/whitespace to minimize LLM token usage",
    { raw_code: z.string() },
    async ({ raw_code }) => ok({ ...compressTokens(raw_code), original_bytes: raw_code.length })
  );

  server.tool("coding-syntax-heartbeat", "Validate JavaScript/TypeScript/JSX syntax",
    { code: z.string() },
    async ({ code }) => ok(await checkSyntax(code))
  );

  server.tool("coding-refactor-suggest", "LLM-powered refactoring suggestions",
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

  server.tool("coding-security-audit", "Static security audit via LLM",
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

  // ── Analysis Bundle ───────────────────────────────────────────────────────

  server.tool("analysis-heartbeat", "Cosine similarity between two texts (BGE embeddings)",
    { text_a: z.string(), text_b: z.string() },
    async ({ text_a, text_b }) => {
      try {
        const [va, vb] = await Promise.all([embed(text_a), embed(text_b)]);
        const sim = cosineSimilarity(va, vb);
        return ok({ similarity: parseFloat(sim.toFixed(6)), vector_dims: va.length });
      } catch { return err("embedding model unavailable"); }
    }
  );

  server.tool("analysis-entity-extractor", "Extract named entities from unstructured text",
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

  server.tool("analysis-context-ranker", "Rank text chunks by relevance to a query",
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

  server.tool("analysis-bias-detector", "Detect framing bias and loaded language in text",
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

  server.tool("analysis-fact-linkage", "Verify a claim via Google Fact Check API or LLM",
    { claim: z.string(), language: z.string().optional().default("en") },
    async ({ claim, language }) => {
      if (env.GOOGLE_FACTCHECK_API_KEY) {
        try {
          const params = new URLSearchParams({ query: claim.slice(0, 512), languageCode: language, key: env.GOOGLE_FACTCHECK_API_KEY, pageSize: "5" });
          const res = await fetch(`https://factchecktools.googleapis.com/v1alpha1/claims:search?${params}`);
          const json = await res.json() as { claims?: unknown[] };
          if (json.claims?.length) return ok({ source: "google_factcheck", claims: json.claims.slice(0, 3) });
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
        return ok({ source: "llm", ...JSON.parse(content) });
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
