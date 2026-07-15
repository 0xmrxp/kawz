// x402 payment middleware — seller-side via @x402/hono v2.
//
// Production (CDP):  @coinbase/x402 v0.3.0 only generates auth headers for
//                   "verify" and "settle". HTTPFacilitatorClient also calls
//                   getSupported() which needs a "supported" key — that key is
//                   missing in the package, causing 401 on every cold start.
//                   buildCdpAuthHeaders() below covers all three operations.
// Testnet fallback:  x402.org/facilitator (no auth, Base Sepolia only).

import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createCorrelationHeader } from "@coinbase/x402";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_PATH = "/platform/v2/x402";
const CDP_URL  = `https://${CDP_HOST}${CDP_PATH}`;

// Two bugs in @coinbase/x402 v0.3.0:
// 1. createCdpAuthHeaders() missing "supported" key → getSupported() sends no auth → 401.
// 2. createAuthHeader() hardcodes requestMethod:"POST" — but getSupported() is a GET
//    request, so the JWT uris claim ("POST .../supported") doesn't match the actual HTTP
//    method → CDP rejects it → 401 even when the key is present.
// Fix: use generateJwt directly with the correct method per operation.
function buildCdpAuthHeaders(apiKeyId: string, apiKeySecret: string) {
  return async () => {
    const make = async (method: string, op: string) => ({
      Authorization: `Bearer ${await generateJwt({
        apiKeyId,
        apiKeySecret,
        requestMethod: method,
        requestHost:   CDP_HOST,
        requestPath:   `${CDP_PATH}/${op}`,
      })}`,
      "Correlation-Context": createCorrelationHeader(),
    });
    return {
      verify:    await make("POST", "verify"),
      settle:    await make("POST", "settle"),
      supported: await make("GET",  "supported"),  // GET — must match getSupported()'s fetch method
    };
  };
}

const TESTNET_FACILITATOR = "https://x402.org/facilitator";
const TESTNET_NETWORK     = "eip155:84532";  // Base Sepolia
const MAINNET_NETWORK     = "eip155:8453";   // Base mainnet

const GET_PATHS = new Set([
  "/api/v1/web/intelligence/url-metadata",
  "/api/v1/onchain/wallet-risk-score",
  "/api/v1/onchain/contract-summary",
  "/api/v1/onchain/token-holders",
  "/api/v1/agent/memory/list",
]);

function methodForPath(path: string): "GET" | "POST" {
  if (GET_PATHS.has(path)) return "GET";
  return path.includes("/trading/") ? "GET" : "POST";
}

// Bazaar discovery extension per route — built with the official declareDiscoveryExtension()
// from @x402/extensions/bazaar. CDP Facilitator auto-indexes endpoints into the Bazaar
// catalog (and agentic.market) after the first successful settlement.
// Each entry includes input schema + output example for improved search quality scores.
const BAZAAR: Record<string, Record<string, unknown>> = {
  "/api/v1/trading/engine/vitals": declareDiscoveryExtension({
    input: { symbols: "btc,eth" },
    inputSchema: {
      properties: { symbols: { type: "string", description: "Comma-separated: btc, eth, or btc,eth. Default: btc,eth" } },
    },
    output: { example: { btc: { price: 65432, change24h: 2.3, volume24h: 28500000000 }, eth: { price: 3210, change24h: 1.1, volume24h: 14200000000 } } },
  }),
  "/api/v1/trading/engine/orderbook-depth": declareDiscoveryExtension({
    input: { pair: "BTC/USDT" },
    inputSchema: {
      properties: { pair: { type: "string", description: "Trading pair e.g. BTC/USDT, ETH/USDT. Default: BTC/USDT" } },
    },
    output: { example: { bids: [[65400, 1.2], [65350, 2.5]], asks: [[65420, 0.8], [65450, 1.5]], spread: 20, imbalance: 0.35 } },
  }),
  "/api/v1/trading/engine/mev-risk-index": declareDiscoveryExtension({
    output: { example: { risk_score: 42, block: 128503241, timestamp: 1752000000000 } },
  }),
  "/api/v1/trading/engine/funding-rates": declareDiscoveryExtension({
    input: { symbols: "BTC,ETH,SOL" },
    inputSchema: {
      properties: { symbols: { type: "string", description: "Comma-separated: BTC,ETH,SOL. Omit for all." } },
    },
    output: { example: { BTC: { rate: 0.0001, interval_hours: 8 }, ETH: { rate: 0.00005, interval_hours: 8 }, SOL: { rate: 0.00012, interval_hours: 8 } } },
  }),
  "/api/v1/trading/engine/whale-tracker": declareDiscoveryExtension({
    input: { threshold: 500000 },
    inputSchema: {
      properties: { threshold: { type: "number", description: "Min USDC transfer USD. Default: 500000" } },
    },
    output: { example: { transfers: [{ from: "0xabc", to: "0xdef", amount: 1500000, tx: "0x123", block: 128503000 }] } },
  }),
  "/api/v1/coding/cache/dependency-tree": declareDiscoveryExtension({
    bodyType: "json",
    input: { code: "import { Hono } from 'hono';", filename: "server.ts" },
    inputSchema: {
      properties: { code: { type: "string" }, filename: { type: "string" } },
      required: ["code"],
    },
    output: { example: { nodes: ["server.ts", "hono"], edges: [{ from: "server.ts", to: "hono", type: "import" }] } },
  }),
  "/api/v1/coding/cache/token-compressor": declareDiscoveryExtension({
    bodyType: "json",
    input: { raw_code: "const x = 1; // comment" },
    inputSchema: {
      properties: { raw_code: { type: "string", description: "Source code to compress for LLM token efficiency" } },
      required: ["raw_code"],
    },
    output: { example: { compressed: "const x=1;", original_tokens: 12, compressed_tokens: 7, ratio: 0.58 } },
  }),
  "/api/v1/coding/cache/syntax-heartbeat": declareDiscoveryExtension({
    bodyType: "json",
    input: { code: "const x = 1;" },
    inputSchema: {
      properties: { code: { type: "string", description: "JS/TS/JSX source code to validate syntax" } },
      required: ["code"],
    },
    output: { example: { valid: true, errors: [] } },
  }),
  "/api/v1/coding/cache/refactor-suggest": declareDiscoveryExtension({
    bodyType: "json",
    input: { code: "function add(a,b){return a+b}", language: "javascript" },
    inputSchema: {
      properties: { code: { type: "string" }, language: { type: "string", description: "javascript or typescript. Default: typescript" } },
      required: ["code"],
    },
    output: { example: { suggestions: [{ severity: "low", description: "Add type annotations", line: 1 }] } },
  }),
  "/api/v1/coding/cache/security-audit": declareDiscoveryExtension({
    bodyType: "json",
    input: { code: "db.query('SELECT * FROM users WHERE id='+req.id)", language: "javascript" },
    inputSchema: {
      properties: { code: { type: "string" }, language: { type: "string", description: "javascript or typescript" } },
      required: ["code"],
    },
    output: { example: { issues: [{ type: "SQL_INJECTION", severity: "high", line: 1, description: "Unsanitized user input in query" }], risk_level: "HIGH" } },
  }),
  "/api/v1/analysis/memory/heartbeat": declareDiscoveryExtension({
    bodyType: "json",
    input: { text_a: "machine learning", text_b: "deep learning" },
    inputSchema: {
      properties: { text_a: { type: "string" }, text_b: { type: "string" } },
      required: ["text_a", "text_b"],
    },
    output: { example: { similarity: 0.87 } },
  }),
  "/api/v1/analysis/memory/entity-extractor": declareDiscoveryExtension({
    bodyType: "json",
    input: { text: "Satoshi Nakamoto published Bitcoin in 2008." },
    inputSchema: {
      properties: { text: { type: "string", description: "Text to extract named entities from" } },
      required: ["text"],
    },
    output: { example: { entities: [{ text: "Satoshi Nakamoto", type: "PERSON" }, { text: "Bitcoin", type: "ORG" }, { text: "2008", type: "DATE" }] } },
  }),
  "/api/v1/analysis/memory/context-ranker": declareDiscoveryExtension({
    bodyType: "json",
    input: { query: "machine learning", chunks: ["deep learning intro", "spreadsheet tutorial"] },
    inputSchema: {
      properties: {
        query: { type: "string" },
        chunks: { type: "array", items: { type: "string" }, description: "Text chunks to re-rank by relevance" },
      },
      required: ["query", "chunks"],
    },
    output: { example: { ranked: [{ text: "deep learning intro", score: 0.91 }, { text: "spreadsheet tutorial", score: 0.12 }] } },
  }),
  "/api/v1/analysis/memory/bias-detector": declareDiscoveryExtension({
    bodyType: "json",
    input: { text: "The radical policy will destroy the economy." },
    inputSchema: {
      properties: { text: { type: "string", description: "Text to analyze for framing bias and loaded language" } },
      required: ["text"],
    },
    output: { example: { bias_score: 0.78, sentiment: "negative", loaded_words: ["radical", "destroy"] } },
  }),
  "/api/v1/analysis/memory/fact-linkage": declareDiscoveryExtension({
    bodyType: "json",
    input: { claim: "The moon landing was faked.", language: "en" },
    inputSchema: {
      properties: { claim: { type: "string" }, language: { type: "string", description: "ISO 639-1 language code. Default: en" } },
      required: ["claim"],
    },
    output: { example: { verdict: "false", confidence: 0.97, sources: [{ url: "https://nasa.gov/apollo", excerpt: "..." }] } },
  }),
  "/api/v1/trading/engine/gas-tracker": declareDiscoveryExtension({
    output: { example: { base: { slow: 0.001, standard: 0.002, fast: 0.005, base_fee: 0.001, unit: "gwei" }, eth: { slow: 8, standard: 15, fast: 35, base_fee: 7, unit: "gwei" }, solana: { low: 1000, medium: 5000, high: 25000, unit: "microlamports" } } },
  }),
  "/api/v1/trading/engine/token-screener": declareDiscoveryExtension({
    input: { exchange: "binance", price_change_min: 5, volume_change_min: 1000000, limit: 20 },
    inputSchema: {
      properties: {
        exchange:          { type: "string", description: "CEX exchange id: binance, okx, bybit. Default: binance" },
        price_change_min:  { type: "number", description: "Min absolute price change % in 24h. Default: 5" },
        volume_change_min: { type: "number", description: "Min 24h volume in USD. Default: 1000000" },
        limit:             { type: "number", description: "Max results (1–50). Default: 20" },
      },
    },
    output: { example: { screened: [{ symbol: "PEPE/USDT", price: 0.0000123, change_24h_pct: 45.2, direction: "up", volume_24h_usd: 850000000 }], count: 1 } },
  }),
  "/api/v1/coding/cache/secret-scanner": declareDiscoveryExtension({
    bodyType: "json",
    input: { code: "const key = 'sk-abc123...';", strict: false },
    inputSchema: {
      properties: {
        code:   { type: "string", description: "Source code to scan for hardcoded secrets" },
        strict: { type: "boolean", description: "Enable strict mode for lower-confidence patterns. Default: false" },
      },
      required: ["code"],
    },
    output: { example: { secrets_found: [{ type: "OPENAI_API_KEY", line: 1, severity: "high", match_hint: "sk-abc...123", recommendation: "Move to environment variable" }], risk_level: "HIGH", total_found: 1, scanned_lines: 1 } },
  }),
  "/api/v1/analysis/memory/sentiment": declareDiscoveryExtension({
    bodyType: "json",
    input: { text: "This product is absolutely amazing!" },
    inputSchema: {
      properties: { text: { type: "string", description: "Text to classify (max 2000 chars)" } },
      required: ["text"],
    },
    output: { example: { sentiment: "positive", confidence: 0.97, dominant_emotion: "joy", brief_reason: "Enthusiastic praise with superlative language" } },
  }),
  "/api/mcp": declareDiscoveryExtension({
    bodyType: "json",
    input: { jsonrpc: "2.0", method: "tools/call", params: { name: "trading-vitals", arguments: {} }, id: 1 },
    inputSchema: {
      properties: {
        jsonrpc: { type: "string", description: "JSON-RPC version, must be '2.0'" },
        method: { type: "string", description: "MCP method e.g. tools/call, tools/list" },
        params: { type: "object" },
        id: { type: "number" },
      },
      required: ["jsonrpc", "method"],
    },
  }),
  // Web Intelligence
  "/api/v1/web/intelligence/url-metadata": declareDiscoveryExtension({
    input: { url: "https://example.com" },
    inputSchema: { properties: { url: { type: "string", description: "URL to extract metadata from" } }, required: ["url"] },
    output: { example: { title: "Example Domain", description: "Example page", og_image: null, canonical: "https://example.com", favicon: "/favicon.ico" } },
  }),
  "/api/v1/web/intelligence/article-parser": declareDiscoveryExtension({
    bodyType: "json",
    input: { url: "https://example.com/article" },
    inputSchema: { properties: { url: { type: "string" } }, required: ["url"] },
    output: { example: { title: "Article Title", text: "Clean article text...", char_count: 4200 } },
  }),
  "/api/v1/web/intelligence/link-extractor": declareDiscoveryExtension({
    bodyType: "json",
    input: { url: "https://example.com", internal_only: false },
    inputSchema: { properties: { url: { type: "string" }, internal_only: { type: "boolean", description: "Return only internal links. Default: false" } }, required: ["url"] },
    output: { example: { total_links: 42, internal_count: 18, external_count: 24, links: [{ href: "https://example.com/page", text: "Page", internal: true }] } },
  }),
  // On-chain Intelligence
  "/api/v1/onchain/wallet-risk-score": declareDiscoveryExtension({
    input: { address: "0x1234...abcd" },
    inputSchema: { properties: { address: { type: "string", description: "EVM wallet address (0x...)" } }, required: ["address"] },
    output: { example: { address: "0x1234...abcd", risk_score: 25, risk_level: "low", factors: [], tx_count: 87 } },
  }),
  "/api/v1/onchain/contract-summary": declareDiscoveryExtension({
    input: { address: "0xabcd...1234" },
    inputSchema: { properties: { address: { type: "string", description: "Smart contract address (0x...)" } }, required: ["address"] },
    output: { example: { address: "0xabcd...1234", name: "UniswapV3Pool", summary: "A Uniswap V3 liquidity pool contract that enables concentrated liquidity provision and token swaps with configurable fee tiers.", functions: ["mint", "burn", "swap"] } },
  }),
  "/api/v1/onchain/tx-classifier": declareDiscoveryExtension({
    bodyType: "json",
    input: { tx_hash: "0xabc...def" },
    inputSchema: { properties: { tx_hash: { type: "string", description: "Transaction hash (0x + 64 hex chars)" } }, required: ["tx_hash"] },
    output: { example: { tx_hash: "0xabc...def", type: "swap", protocol: "Uniswap V3", value_eth: 0.5, from: "0x...", to: "0x..." } },
  }),
  "/api/v1/onchain/token-holders": declareDiscoveryExtension({
    input: { address: "0xtoken...", limit: 20 },
    inputSchema: { properties: { address: { type: "string", description: "Token contract address" }, limit: { type: "number", description: "Max holders to return (5–50). Default: 20" } }, required: ["address"] },
    output: { example: { token: "0xtoken...", holder_count: 20, gini_coefficient: 0.72, top_holders: [{ address: "0x...", quantity: "1000000", share_pct: 12.5 }] } },
  }),
  // Agent Memory
  "/api/v1/agent/memory/store": declareDiscoveryExtension({
    bodyType: "json",
    input: { text: "User prefers concise responses.", session_id: "agent-xyz-001", tags: ["preference"] },
    inputSchema: { properties: { text: { type: "string", description: "Memory content (max 4000 chars)" }, session_id: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["text", "session_id"] },
    output: { example: { memory_id: "uuid-here", session_id: "agent-xyz-001", char_count: 31, timestamp: 1752000000000 } },
  }),
  "/api/v1/agent/memory/recall": declareDiscoveryExtension({
    bodyType: "json",
    input: { query: "user response preferences", session_id: "agent-xyz-001", limit: 5, threshold: 0.5 },
    inputSchema: { properties: { query: { type: "string" }, session_id: { type: "string" }, limit: { type: "number", description: "Max results (1–20). Default: 5" }, threshold: { type: "number", description: "Min similarity score (0–1). Default: 0.5" } }, required: ["query", "session_id"] },
    output: { example: { results: [{ memory_id: "uuid", score: 0.91, text: "User prefers concise responses.", tags: ["preference"] }], count: 1 } },
  }),
  "/api/v1/agent/memory/forget": declareDiscoveryExtension({
    bodyType: "json",
    input: { memory_id: "uuid-here", session_id: "agent-xyz-001" },
    inputSchema: { properties: { memory_id: { type: "string" }, session_id: { type: "string" } }, required: ["memory_id", "session_id"] },
    output: { example: { memory_id: "uuid-here", deleted: true } },
  }),
  "/api/v1/agent/memory/list": declareDiscoveryExtension({
    input: { session_id: "agent-xyz-001", limit: 20 },
    inputSchema: { properties: { session_id: { type: "string" }, limit: { type: "number", description: "Max memories (1–100). Default: 20" } }, required: ["session_id"] },
    output: { example: { memories: [{ memory_id: "uuid", text: "User prefers concise...", tags: [], timestamp: 1752000000000 }], count: 1 } },
  }),
};

const ROUTE_DESCRIPTIONS: Record<string, string> = {
  "/api/v1/trading/engine/vitals":            "Live BTC/ETH price, 24h change and volume from CEX feeds.",
  "/api/v1/trading/engine/orderbook-depth":   "CEX orderbook bids/asks, spread and imbalance for a trading pair.",
  "/api/v1/trading/engine/mev-risk-index":    "MEV sandwich attack risk score 0-100 for the current Base block.",
  "/api/v1/trading/engine/funding-rates":     "Perpetual futures funding rates for BTC, ETH, SOL from CEX futures markets.",
  "/api/v1/trading/engine/whale-tracker":     "Recent large USDC transfers on Base. On-chain data.",
  "/api/v1/coding/cache/dependency-tree":     "Parse import/export dependency graph from JavaScript or TypeScript source.",
  "/api/v1/coding/cache/token-compressor":    "Strip comments and whitespace from source code to minimize LLM token usage.",
  "/api/v1/coding/cache/syntax-heartbeat":    "Validate JavaScript/TypeScript/JSX syntax and return parse errors.",
  "/api/v1/coding/cache/refactor-suggest":    "LLM-powered refactoring suggestions with severity ratings.",
  "/api/v1/coding/cache/security-audit":      "Static security audit — detect SQL injection, XSS, hardcoded secrets.",
  "/api/v1/analysis/memory/heartbeat":        "Cosine similarity between two texts using sentence embeddings.",
  "/api/v1/analysis/memory/entity-extractor": "Extract named entities (people, orgs, dates, locations, money) from text.",
  "/api/v1/analysis/memory/context-ranker":   "Re-rank text chunks by semantic relevance to a query using sentence embeddings.",
  "/api/v1/analysis/memory/bias-detector":    "Detect framing bias, sentiment slant, and loaded language in text.",
  "/api/v1/analysis/memory/fact-linkage":     "Verify claims via fact-check databases with LLM fallback.",
  "/api/v1/trading/engine/gas-tracker":     "Gas prices for ETH, Base, and Solana — slow/standard/fast tiers in native units.",
  "/api/v1/trading/engine/token-screener": "Scan CEX tokens by 24h price change and volume. Returns top movers above threshold.",
  "/api/v1/coding/cache/secret-scanner":   "Detect hardcoded secrets, API keys, private keys, and tokens in source code.",
  "/api/v1/analysis/memory/sentiment":     "Classify text sentiment as positive, negative, or neutral with confidence score.",
  "/api/mcp":                                    "MCP server — all Lobre tools via Streamable HTTP Transport.",
  "/api/v1/web/intelligence/url-metadata":       "Extract title, description, OG tags, canonical URL, and favicon from any web page.",
  "/api/v1/web/intelligence/article-parser":     "Fetch a URL and return clean article text with scripts, ads, and nav stripped.",
  "/api/v1/web/intelligence/link-extractor":     "Extract all links from a web page with text context and internal/external classification.",
  "/api/v1/onchain/wallet-risk-score":           "Risk score (0-100) for an EVM wallet based on failed tx ratio and behavior patterns.",
  "/api/v1/onchain/contract-summary":            "Plain-English summary of a smart contract using ABI and source code from Blockscout.",
  "/api/v1/onchain/tx-classifier":               "Classify a transaction as swap, bridge, NFT mint, approval, or transfer by input signature.",
  "/api/v1/onchain/token-holders":               "Top holders for a token contract with Gini coefficient for concentration analysis.",
  "/api/v1/agent/memory/store":                  "Store a text memory chunk for an agent session with auto-embedding.",
  "/api/v1/agent/memory/recall":                 "Retrieve the most relevant memories for a query within a session using semantic search.",
  "/api/v1/agent/memory/forget":                 "Delete a specific memory by ID from an agent session.",
  "/api/v1/agent/memory/list":                   "List all stored memories for an agent session, sorted by recency.",
};

export function createX402Middleware(env: Env): MiddlewareHandler {
  const isPaymentEnabled =
    env.ENVIRONMENT === "production" || process.env.FORCE_PAYMENT === "true";

  if (!isPaymentEnabled) {
    return async (_c, next) => next();
  }

  const isProd    = env.ENVIRONMENT === "production" && !!env.CDP_API_KEY_ID;
  const network   = isProd ? MAINNET_NETWORK : TESTNET_NETWORK;

  // buildCdpAuthHeaders covers verify + settle + supported.
  // The @coinbase/x402 v0.3.0 package misses "supported", causing 401 on getSupported().
  let facilitatorClient: InstanceType<typeof HTTPFacilitatorClient>;
  if (isProd) {
    facilitatorClient = new HTTPFacilitatorClient({
      url: CDP_URL,
      createAuthHeaders: buildCdpAuthHeaders(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET),
    });
  } else {
    facilitatorClient = new HTTPFacilitatorClient({ url: TESTNET_FACILITATOR });
  }

  // register() may not be chainable (returns void in some versions of @x402/hono).
  // Separate the call so resourceServer is always the class instance, not undefined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resourceServer = new x402ResourceServer(facilitatorClient) as any;
  resourceServer.register(network, new ExactEvmScheme());

  const routes: Record<string, unknown> = {};
  for (const [path, pricing] of Object.entries(ROUTE_PRICE_MAP)) {
    const method    = methodForPath(path);
    const bazaarExt = BAZAAR[path];

    // Register both path formats — paymentMiddleware may use c.req.path (basePath-relative,
    // /v1/...) or the full URL path (/api/v1/...) depending on @x402/hono internals.
    // Registering both ensures one always matches regardless of which path is used.
    const routePathShort = path.replace(/^\/api/, ""); // /v1/...
    const routeConfig = {
      accepts: [{
        payTo:   env.EVM_PAYEE_ADDRESS,
        scheme:  "exact",
        price:   `$${pricing.usdAmount}`,
        network,
      }],
      description: ROUTE_DESCRIPTIONS[path],
      mimeType: "application/json",
      ...(bazaarExt && { extensions: bazaarExt }),
    };

    routes[`${method} ${routePathShort}`] = routeConfig; // /v1/... (c.req.path, basePath-relative)
    routes[`${method} ${path}`]           = routeConfig; // /api/v1/... (full URL pathname)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(routes as any, resourceServer as any) as any;
}
