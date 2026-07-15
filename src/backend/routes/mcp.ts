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

  // ── Web Intelligence Bundle ───────────────────────────────────────────────

  server.tool("web-url-metadata", "Extract title, description, OG tags, canonical URL, and favicon from any web page.",
    { url: z.string() },
    async ({ url }) => {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Lobre/1.2" }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return err("failed to fetch URL");
        const html = await res.text();
        const tag = (re: RegExp) => { const m = re.exec(html); return m ? (m[1] ?? m[2] ?? null) : null; };
        const title       = tag(/<title[^>]*>([^<]*)<\/title>/i);
        const description = tag(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
                         ?? tag(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
        const ogTitle     = tag(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
                         ?? tag(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i);
        const ogImage     = tag(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i)
                         ?? tag(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:image["']/i);
        const canonical   = tag(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)
                         ?? tag(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["']canonical["']/i);
        const favicon     = tag(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i)
                         ?? tag(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
        return ok({ url, title, description, og_title: ogTitle, og_image: ogImage, canonical, favicon });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("web-article-parser", "Fetch a URL and return clean article text with scripts, ads, and nav stripped.",
    { url: z.string() },
    async ({ url }) => {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Lobre/1.2" }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return err("failed to fetch URL");
        const html = await res.text();
        const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
        const title = titleMatch?.[1]?.trim() ?? null;
        let body = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[\s\S]*?<\/footer>/gi, "");
        const articleMatch = /<article[\s\S]*?<\/article>/i.exec(body) ?? /<main[\s\S]*?<\/main>/i.exec(body);
        if (articleMatch) body = articleMatch[0];
        const text = body
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 6000);
        return ok({ title, text, char_count: text.length });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("web-link-extractor", "Extract all links from a web page with text and internal/external classification.",
    { url: z.string(), internal_only: z.boolean().optional().default(false) },
    async ({ url, internal_only }) => {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Lobre/1.2" }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) return err("failed to fetch URL");
        const html = await res.text();
        const origin = new URL(url).origin;
        const linkRe = /<a[^>]+href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
        const seen = new Set<string>();
        const links: { href: string; text: string; internal: boolean }[] = [];
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(html)) !== null && links.length < 100) {
          const rawHref = m[1].trim();
          let href: string;
          try { href = new URL(rawHref, url).href; } catch { continue; }
          if (seen.has(href)) continue;
          seen.add(href);
          const internal = href.startsWith(origin);
          if (internal_only && !internal) continue;
          const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
          links.push({ href, text, internal });
        }
        return ok({ total_links: links.length, links });
      } catch { return err("upstream unavailable"); }
    }
  );

  // ── On-chain Intelligence Bundle ──────────────────────────────────────────

  server.tool("onchain-wallet-risk-score", "Risk score 0-100 for an EVM wallet based on transaction history.",
    { address: z.string() },
    async ({ address }) => {
      if (!/^0x[0-9a-f]{40}$/i.test(address)) return err("invalid EVM address");
      try {
        const res  = await fetch(`${env.BLOCKSCOUT_BASE_URL}/api?module=account&action=txlist&address=${address}&sort=desc&page=1&offset=100`);
        const json = await res.json() as { status: string; result?: Record<string, string>[] };
        if (json.status !== "1" || !Array.isArray(json.result)) return ok({ address, risk_score: 0, risk_level: "unknown", factors: [], tx_count: 0 });
        const txs = json.result;
        const failedRatio = txs.length ? txs.filter(tx => tx.isError === "1").length / txs.length : 0;
        const timestamps  = txs.map(tx => parseInt(tx.timeStamp ?? "0")).sort((a, b) => a - b);
        let burstCount = 0;
        for (let i = 1; i < timestamps.length; i++) if (timestamps[i] - timestamps[i - 1] < 5) burstCount++;
        const burstRatio = timestamps.length > 1 ? burstCount / (timestamps.length - 1) : 0;
        const score = Math.min(100, Math.round(failedRatio * 60 + burstRatio * 40));
        const risk_level = score < 20 ? "low" : score < 50 ? "medium" : score < 80 ? "high" : "critical";
        const factors: string[] = [];
        if (failedRatio > 0.1) factors.push(`high_failed_tx_ratio:${(failedRatio * 100).toFixed(1)}%`);
        if (burstRatio > 0.2)  factors.push(`burst_tx_pattern:${(burstRatio * 100).toFixed(1)}%`);
        return ok({ address, risk_score: score, risk_level, factors, tx_count: txs.length });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("onchain-contract-summary", "Plain-English summary of a smart contract from Blockscout.",
    { address: z.string() },
    async ({ address }) => {
      if (!/^0x[0-9a-f]{40}$/i.test(address)) return err("invalid EVM address");
      try {
        const [srcRes, abiRes] = await Promise.all([
          fetch(`${env.BLOCKSCOUT_BASE_URL}/api?module=contract&action=getsourcecode&address=${address}`),
          fetch(`${env.BLOCKSCOUT_BASE_URL}/api?module=contract&action=getabi&address=${address}`),
        ]);
        const srcJson = await srcRes.json() as { status: string; result?: { ContractName?: string; SourceCode?: string }[] };
        const abiJson = await abiRes.json() as { status: string; result?: string };
        const contractName = srcJson.result?.[0]?.ContractName ?? "Unknown";
        let functions: string[] = [];
        if (abiJson.status === "1" && abiJson.result) {
          try {
            const abi = JSON.parse(abiJson.result) as { type: string; name?: string }[];
            functions = abi.filter(e => e.type === "function").map(e => e.name ?? "").filter(Boolean);
          } catch { /* ignore */ }
        }
        const content = await llmChat(llm, {
          temperature: 0.2, maxTokens: 256, jsonOutput: false,
          messages: [
            { role: "system", content: "Summarize the smart contract in 2-3 sentences based on its name and functions. Be concise and technical." },
            { role: "user", content: `Contract: ${contractName}\nFunctions: ${functions.slice(0, 30).join(", ")}` },
          ],
        });
        return ok({ address, name: contractName, summary: content.trim(), functions });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("onchain-tx-classifier", "Classify a Base transaction as swap, bridge, NFT mint, approval, or transfer.",
    { tx_hash: z.string() },
    async ({ tx_hash }) => {
      if (!/^0x[0-9a-f]{64}$/i.test(tx_hash)) return err("invalid transaction hash");
      try {
        const rpcRes = await fetch(env.BASE_RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionByHash", params: [tx_hash], id: 1 }) });
        const { result: tx } = await rpcRes.json() as { result: Record<string, string> | null };
        if (!tx) return err("transaction not found");
        const input    = tx.input ?? "0x";
        const selector = input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x";
        const SIG_MAP: Record<string, { type: string; protocol: string }> = {
          "0x7ff36ab5": { type: "swap",          protocol: "UniswapV2"   },
          "0x38ed1739": { type: "swap",          protocol: "UniswapV2"   },
          "0x414bf389": { type: "swap",          protocol: "UniswapV3"   },
          "0xc04b8d59": { type: "swap",          protocol: "UniswapV3"   },
          "0x56688700": { type: "bridge",        protocol: "BaseBridge"  },
          "0x1249c58b": { type: "nft_mint",      protocol: ""            },
          "0x095ea7b3": { type: "token_approval", protocol: ""           },
          "0xa22cb465": { type: "nft_approval",  protocol: ""            },
        };
        const classified = selector === "0x" ? { type: "transfer", protocol: "eth" } : (SIG_MAP[selector] ?? { type: "unknown", protocol: "" });
        const value_eth  = tx.value ? parseFloat((parseInt(tx.value, 16) / 1e18).toFixed(8)) : 0;
        return ok({ tx_hash, type: classified.type, protocol: classified.protocol, value_eth, from: tx.from, to: tx.to });
      } catch { return err("upstream unavailable"); }
    }
  );

  server.tool("onchain-token-holders", "Top holders for a token contract with Gini coefficient.",
    { address: z.string(), limit: z.number().optional().default(20) },
    async ({ address, limit }) => {
      if (!/^0x[0-9a-f]{40}$/i.test(address)) return err("invalid EVM address");
      try {
        const res  = await fetch(`${env.BLOCKSCOUT_BASE_URL}/api?module=token&action=getTokenHolders&contractaddress=${address}&page=1&offset=${Math.min(limit, 50)}`);
        const json = await res.json() as { status: string; result?: { address: string; value: string }[] };
        if (json.status !== "1" || !Array.isArray(json.result)) return ok({ token: address, holder_count: 0, gini_coefficient: 0, top_holders: [] });
        const holders = json.result;
        const balances = holders.map(h => parseFloat(h.value ?? "0")).sort((a, b) => a - b);
        const n = balances.length;
        let gini = 0;
        if (n > 1) {
          const total = balances.reduce((s, v) => s + v, 0);
          if (total > 0) {
            let sumDiff = 0;
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) sumDiff += Math.abs(balances[i] - balances[j]);
            gini = parseFloat((sumDiff / (2 * n * total)).toFixed(4));
          }
        }
        const top_holders = holders.map(h => ({ address: h.address, balance: h.value }));
        return ok({ token: address, holder_count: holders.length, gini_coefficient: gini, top_holders });
      } catch { return err("upstream unavailable"); }
    }
  );

  // ── Agent Memory Bundle ───────────────────────────────────────────────────

  server.tool("agent-memory-store", "Store a text memory chunk for an agent session with auto-embedding via Qdrant.",
    { text: z.string(), session_id: z.string(), tags: z.array(z.string()).optional().default([]) },
    async ({ text, session_id, tags }) => {
      if (text.length > 4000) return err("text exceeds 4000 character limit");
      try {
        const vector = await embed(text);
        const memory_id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.floor(Math.random() * 16); return (c === "x" ? r : (r & 0x3) | 0x8).toString(16); });
        const timestamp  = Date.now();
        // Ensure collection exists
        try { await fetch(`${env.QDRANT_URL}/collections/agent_memory`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vectors: { size: 768, distance: "Cosine" } }) }); } catch { /* ignore */ }
        const pointRes = await fetch(`${env.QDRANT_URL}/collections/agent_memory/points`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: [{ id: memory_id, vector, payload: { text, session_id, tags, timestamp } }] }) });
        if (!pointRes.ok) return err("failed to store memory");
        return ok({ memory_id, session_id, char_count: text.length, timestamp });
      } catch { return err("memory store unavailable"); }
    }
  );

  server.tool("agent-memory-recall", "Retrieve relevant memories for a query using semantic search in Qdrant.",
    { query: z.string(), session_id: z.string(), limit: z.number().optional().default(5), threshold: z.number().optional().default(0.5) },
    async ({ query, session_id, limit, threshold }) => {
      try {
        const vector   = await embed(query);
        const searchRes = await fetch(`${env.QDRANT_URL}/collections/agent_memory/points/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vector, limit: Math.min(limit, 20), score_threshold: threshold, with_payload: true, filter: { must: [{ key: "session_id", match: { value: session_id } }] } }) });
        if (!searchRes.ok) return err("memory search failed");
        const json = await searchRes.json() as { result?: { id: string; score: number; payload?: { text?: string; tags?: string[]; timestamp?: number } }[] };
        const results = (json.result ?? []).map(r => ({ memory_id: r.id, score: parseFloat(r.score.toFixed(4)), text: r.payload?.text ?? "", tags: r.payload?.tags ?? [], timestamp: r.payload?.timestamp ?? null }));
        return ok({ results, count: results.length });
      } catch { return err("memory store unavailable"); }
    }
  );

  server.tool("agent-memory-forget", "Delete a specific memory from an agent session.",
    { memory_id: z.string(), session_id: z.string() },
    async ({ memory_id, session_id }) => {
      try {
        const getRes = await fetch(`${env.QDRANT_URL}/collections/agent_memory/points/${memory_id}`);
        if (!getRes.ok) return err("memory not found");
        const getJson = await getRes.json() as { result?: { payload?: { session_id?: string } } };
        if (getJson.result?.payload?.session_id !== session_id) return err("memory_id does not belong to this session");
        const delRes = await fetch(`${env.QDRANT_URL}/collections/agent_memory/points/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: [memory_id] }) });
        if (!delRes.ok) return err("failed to delete memory");
        return ok({ memory_id, deleted: true });
      } catch { return err("memory store unavailable"); }
    }
  );

  server.tool("agent-memory-list", "List all memories stored for an agent session.",
    { session_id: z.string(), limit: z.number().optional().default(20) },
    async ({ session_id, limit }) => {
      try {
        const scrollRes = await fetch(`${env.QDRANT_URL}/collections/agent_memory/points/scroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: Math.min(limit, 50), with_payload: true, with_vector: false, filter: { must: [{ key: "session_id", match: { value: session_id } }] } }) });
        if (!scrollRes.ok) return err("memory list failed");
        const json = await scrollRes.json() as { result?: { points?: { id: string; payload?: { text?: string; tags?: string[]; timestamp?: number } }[] } };
        const memories = (json.result?.points ?? []).map(p => ({ memory_id: p.id, text: (p.payload?.text ?? "").slice(0, 200), tags: p.payload?.tags ?? [], timestamp: p.payload?.timestamp ?? null }));
        return ok({ memories, count: memories.length });
      } catch { return err("memory store unavailable"); }
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
