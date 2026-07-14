// x402 payment middleware — seller-side via @x402/hono v2.
// Bazaar discovery metadata declared per-route via declareDiscoveryExtension()
// from @x402/extensions/bazaar — enables CDP Bazaar catalog indexing.

import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const TESTNET_FACILITATOR = "https://x402.org/facilitator";
const PROD_FACILITATOR   = "https://api.cdp.coinbase.com/platform/v2/x402";
const TESTNET_NETWORK    = "eip155:84532";
const MAINNET_NETWORK    = "eip155:8453";

function methodForPath(path: string): "GET" | "POST" {
  return path.includes("/trading/") ? "GET" : "POST";
}

// Bazaar discovery metadata per route — input/output schema + examples.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getBazaarExtension(path: string): Record<string, any> {
  const isPost = methodForPath(path) === "POST";
  const base = isPost ? { bodyType: "json" as const } : {};

  const meta: Record<string, { input?: unknown; inputSchema?: unknown; output?: { example?: unknown } }> = {
    "/api/v1/trading/engine/vitals": {
      output: { example: { source: "binance", btc: { price_usd: 67420, change_24h_pct: 2.4 }, eth: { price_usd: 3520 }, timestamp: 1720000000000 } },
    },
    "/api/v1/trading/engine/orderbook-depth": {
      input: { pair: "BTC/USDT" },
      inputSchema: { type: "object", properties: { pair: { type: "string", description: "Trading pair, e.g. BTC/USDT" } } },
      output: { example: { pair: "BTC/USDT", best_bid: 67400, best_ask: 67410, spread_pct: 0.015, imbalance: -0.08 } },
    },
    "/api/v1/trading/engine/mev-risk-index": {
      output: { example: { risk_score: 18, risk_level: "low", block_number: 16780000, total_txs: 142 } },
    },
    "/api/v1/trading/engine/funding-rates": {
      output: { example: { rates: [{ symbol: "BTC/USDT:USDT", funding_rate: 0.0001, annualized_pct: 10.95 }] } },
    },
    "/api/v1/trading/engine/whale-tracker": {
      output: { example: { large_transfers: [{ hash: "0x...", amount_usdc: 1250000 }], threshold_usd: 500000 } },
    },
    "/api/v1/coding/cache/dependency-tree": {
      input: { code: "import { Hono } from 'hono';" },
      inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, filename: { type: "string" } } },
      output: { example: { imports: ["hono"], exports: [], depth: 1 } },
    },
    "/api/v1/coding/cache/token-compressor": {
      input: { raw_code: "// comment\nconst x = 1;" },
      inputSchema: { type: "object", required: ["raw_code"], properties: { raw_code: { type: "string" } } },
      output: { example: { compressed: "const x = 1;", ratio_pct: 48, original_bytes: 24, compressed_bytes: 13 } },
    },
    "/api/v1/coding/cache/syntax-heartbeat": {
      input: { code: "const x = 1;" },
      inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } },
      output: { example: { valid: true, errors: [], lines: 1 } },
    },
    "/api/v1/coding/cache/refactor-suggest": {
      input: { code: "function add(a,b){return a+b}", language: "javascript" },
      inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } },
      output: { example: { suggestions: [{ severity: "low", description: "Add type annotations" }], overall_quality: "fair" } },
    },
    "/api/v1/coding/cache/security-audit": {
      input: { code: "db.query(`SELECT * FROM users WHERE id=${req.id}`)" },
      inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } },
      output: { example: { vulnerabilities: [{ id: "SQL001", severity: "critical", title: "SQL Injection" }], risk_score: 85 } },
    },
    "/api/v1/analysis/memory/heartbeat": {
      input: { text_a: "machine learning", text_b: "artificial intelligence" },
      inputSchema: { type: "object", required: ["text_a", "text_b"], properties: { text_a: { type: "string" }, text_b: { type: "string" } } },
      output: { example: { similarity: 0.887, similarity_pct: 88.7, interpretation: "very similar" } },
    },
    "/api/v1/analysis/memory/entity-extractor": {
      input: { text: "Satoshi Nakamoto published Bitcoin in 2008." },
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      output: { example: { entities: [{ text: "Satoshi Nakamoto", type: "PERSON", confidence: "high" }], entity_count: 3 } },
    },
    "/api/v1/analysis/memory/context-ranker": {
      input: { query: "machine learning", chunks: ["deep learning", "spreadsheets", "neural networks"] },
      inputSchema: { type: "object", required: ["query", "chunks"], properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } } },
      output: { example: { ranked: [{ index: 0, score: 0.921, chunk: "deep learning" }] } },
    },
    "/api/v1/analysis/memory/bias-detector": {
      input: { text: "The radical policy will destroy the economy." },
      inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      output: { example: { bias_detected: true, bias_types: ["loaded_language"], bias_score: 72 } },
    },
    "/api/v1/analysis/memory/fact-linkage": {
      input: { claim: "The moon landing was faked.", language: "en" },
      inputSchema: { type: "object", required: ["claim"], properties: { claim: { type: "string" }, language: { type: "string", default: "en" } } },
      output: { example: { source: "google_factcheck", claims: [{ reviews: [{ publisher: "Snopes", rating: "False" }] }] } },
    },
  };

  const m = meta[path];
  if (!m) return {};
  return declareDiscoveryExtension({ ...base, ...m });
}

export function createX402Middleware(env: Env): MiddlewareHandler {
  const isPaymentEnabled =
    env.ENVIRONMENT === "production" || process.env.FORCE_PAYMENT === "true";

  if (!isPaymentEnabled) {
    return async (_c, next) => next();
  }

  const isProd = env.ENVIRONMENT === "production" && !!env.CDP_API_KEY_ID;
  const facilitatorUrl = isProd ? PROD_FACILITATOR : TESTNET_FACILITATOR;
  const network        = isProd ? MAINNET_NETWORK  : TESTNET_NETWORK;

  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

  // Register ExactEvmScheme + Bazaar extension on resourceServer.
  // bazaarResourceServerExtension narrows the HTTP method per request at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resourceServer = (new x402ResourceServer(facilitatorClient) as any)
    .register(network, new ExactEvmScheme())
    .register(bazaarResourceServerExtension);

  const routes: Record<string, unknown> = {};
  for (const [path, pricing] of Object.entries(ROUTE_PRICE_MAP)) {
    const method = methodForPath(path);
    routes[`${method} ${path}`] = {
      accepts: [{
        payTo:   env.EVM_PAYEE_ADDRESS,
        scheme:  "exact",
        price:   `$${pricing.usdAmount}`,
        network,
      }],
      extensions: getBazaarExtension(path),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(routes as any, resourceServer as any) as any;
}
