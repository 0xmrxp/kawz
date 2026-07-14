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

function methodForPath(path: string): "GET" | "POST" {
  return path.includes("/trading/") ? "GET" : "POST";
}

// Bazaar discovery metadata per route — simple format per official CDP docs.
// discoverable: true enables CDP Bazaar crawler to index this endpoint.
const BAZAAR_META: Record<string, { category: string; tags: string[] }> = {
  "/api/v1/trading/engine/vitals":            { category: "trading",  tags: ["market-data", "crypto", "btc", "eth"] },
  "/api/v1/trading/engine/orderbook-depth":   { category: "trading",  tags: ["orderbook", "liquidity", "dex"] },
  "/api/v1/trading/engine/mev-risk-index":    { category: "trading",  tags: ["mev", "risk", "onchain"] },
  "/api/v1/trading/engine/funding-rates":     { category: "trading",  tags: ["funding-rates", "futures", "perpetuals"] },
  "/api/v1/trading/engine/whale-tracker":     { category: "trading",  tags: ["whale", "onchain", "usdc"] },
  "/api/v1/coding/cache/dependency-tree":     { category: "developer-tools", tags: ["ast", "dependencies", "typescript"] },
  "/api/v1/coding/cache/token-compressor":    { category: "developer-tools", tags: ["compression", "llm", "code"] },
  "/api/v1/coding/cache/syntax-heartbeat":    { category: "developer-tools", tags: ["syntax", "validation", "typescript"] },
  "/api/v1/coding/cache/refactor-suggest":    { category: "developer-tools", tags: ["refactor", "llm", "code-review"] },
  "/api/v1/coding/cache/security-audit":      { category: "developer-tools", tags: ["security", "audit", "vulnerabilities"] },
  "/api/v1/analysis/memory/heartbeat":        { category: "ai-tools", tags: ["embeddings", "similarity", "nlp"] },
  "/api/v1/analysis/memory/entity-extractor": { category: "ai-tools", tags: ["ner", "entities", "nlp"] },
  "/api/v1/analysis/memory/context-ranker":   { category: "ai-tools", tags: ["reranking", "retrieval", "rag"] },
  "/api/v1/analysis/memory/bias-detector":    { category: "ai-tools", tags: ["bias", "nlp", "media-analysis"] },
  "/api/v1/analysis/memory/fact-linkage":     { category: "ai-tools", tags: ["fact-check", "verification", "claims"] },
  "/api/mcp":                                { category: "developer-tools", tags: ["mcp", "agents", "infrastructure", "tools"] },
};

// Per x402scan DISCOVERY.md spec: input schema must be in accepts[].extensions.bazaar
// Format: { info: { input: {...example} }, schema: { properties: {...}, required: [...] } }
// Per @x402/extensions/bazaar declareDiscoveryExtension() spec:
// - info.input: example with { type, method, bodyType?, body?, queryParams? }
// - schema: JSON Schema describing the valid info STRUCTURE (not example data)
//   @x402/hono validates `info` against `schema` using AJV
//   x402scan reads schema.properties.input.properties.body/queryParams for input schema
const S_GET    = { type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET","HEAD","DELETE"] } }, required: ["type","method"], additionalProperties: false } }, required: ["input"] };
const S_GET_QP = (qp: unknown) => ({ type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET","HEAD","DELETE"] }, queryParams: { type: "object", properties: qp as Record<string,unknown> } }, required: ["type","method"], additionalProperties: false } }, required: ["input"] });
const S_POST   = (body: unknown, req: string[]) => ({ type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["POST","PUT","PATCH"] }, bodyType: { type: "string", enum: ["json"] }, body: { type: "object", properties: body as Record<string,unknown>, required: req } }, required: ["type","method","bodyType","body"], additionalProperties: false } }, required: ["input"] });

const BAZAAR_ACCEPT_SCHEMA: Record<string, { info: unknown; schema: unknown }> = {
  "/api/v1/trading/engine/vitals":            { info: { input: { type: "http", method: "GET", queryParams: { symbols: "btc,eth" } } },                                                       schema: S_GET_QP({ symbols: { type: "string", description: "btc, eth or btc,eth. Default: btc,eth" } }) },
  "/api/v1/trading/engine/orderbook-depth":   { info: { input: { type: "http", method: "GET", queryParams: { pair: "BTC/USDT" } } },                                                        schema: S_GET_QP({ pair: { type: "string", description: "Trading pair, default BTC/USDT" } }) },
  "/api/v1/trading/engine/mev-risk-index":    { info: { input: { type: "http", method: "GET" } },                                                                                            schema: S_GET },
  "/api/v1/trading/engine/funding-rates":     { info: { input: { type: "http", method: "GET", queryParams: { symbols: "" } } },                                                              schema: S_GET_QP({ symbols: { type: "string", description: "Comma-separated: BTC,ETH,SOL. Omit for all." } }) },
  "/api/v1/trading/engine/whale-tracker":     { info: { input: { type: "http", method: "GET", queryParams: { threshold: 500000 } } },                                                        schema: S_GET_QP({ threshold: { type: "number", description: "Min USDC transfer USD. Default: 500000" } }) },
  "/api/v1/coding/cache/dependency-tree":     { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "import { Hono } from 'hono';", filename: "server.ts" } } }, schema: S_POST({ code: { type: "string" }, filename: { type: "string" } }, ["code"]) },
  "/api/v1/coding/cache/token-compressor":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { raw_code: "const x = 1; // comment" } } },                         schema: S_POST({ raw_code: { type: "string" } }, ["raw_code"]) },
  "/api/v1/coding/cache/syntax-heartbeat":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "const x = 1;" } } },                                        schema: S_POST({ code: { type: "string" } }, ["code"]) },
  "/api/v1/coding/cache/refactor-suggest":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "function add(a,b){return a+b}", language: "javascript" } } }, schema: S_POST({ code: { type: "string" }, language: { type: "string" } }, ["code"]) },
  "/api/v1/coding/cache/security-audit":      { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "db.query('SELECT * FROM users WHERE id='+req.id)", language: "javascript" } } }, schema: S_POST({ code: { type: "string" }, language: { type: "string" } }, ["code"]) },
  "/api/v1/analysis/memory/heartbeat":        { info: { input: { type: "http", method: "POST", bodyType: "json", body: { text_a: "machine learning", text_b: "deep learning" } } },         schema: S_POST({ text_a: { type: "string" }, text_b: { type: "string" } }, ["text_a","text_b"]) },
  "/api/v1/analysis/memory/entity-extractor": { info: { input: { type: "http", method: "POST", bodyType: "json", body: { text: "Satoshi Nakamoto published Bitcoin in 2008." } } },          schema: S_POST({ text: { type: "string" } }, ["text"]) },
  "/api/v1/analysis/memory/context-ranker":   { info: { input: { type: "http", method: "POST", bodyType: "json", body: { query: "machine learning", chunks: ["deep learning","spreadsheets"] } } }, schema: S_POST({ query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } }, ["query","chunks"]) },
  "/api/v1/analysis/memory/bias-detector":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { text: "The radical policy will destroy the economy." } } },         schema: S_POST({ text: { type: "string" } }, ["text"]) },
  "/api/v1/analysis/memory/fact-linkage":     { info: { input: { type: "http", method: "POST", bodyType: "json", body: { claim: "The moon landing was faked.", language: "en" } } },         schema: S_POST({ claim: { type: "string" }, language: { type: "string" } }, ["claim"]) },
  "/api/mcp":                                { info: { input: { type: "http", method: "POST", bodyType: "json", body: { jsonrpc: "2.0", method: "tools/call", params: { name: "trading-vitals", arguments: {} }, id: 1 } } }, schema: S_POST({ jsonrpc: { type: "string" }, method: { type: "string" }, params: { type: "object" }, id: { type: "number" } }, ["jsonrpc", "method"]) },
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
  "/api/mcp":                                "MCP server — all 15 Lobre tools via Streamable HTTP Transport.",
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resourceServer = (new x402ResourceServer(facilitatorClient) as any)
    .register(network, new ExactEvmScheme());

  const routes: Record<string, unknown> = {};
  for (const [path, pricing] of Object.entries(ROUTE_PRICE_MAP)) {
    const method     = methodForPath(path);
    const bazaarBase = BAZAAR_ACCEPT_SCHEMA[path];
    const bazaarMeta = BAZAAR_META[path];

    // paymentMiddleware matches against c.req.path which is basePath-relative (/v1/...)
    // inside an app with .basePath("/api"). Strip the /api prefix so routes match correctly.
    const routePath = path.replace(/^\/api/, "");

    routes[`${method} ${routePath}`] = {
      accepts: [{
        payTo:   env.EVM_PAYEE_ADDRESS,
        scheme:  "exact",
        price:   `$${pricing.usdAmount}`,
        network,
      }],
      description: ROUTE_DESCRIPTIONS[path],
      mimeType: "application/json",
      extensions: { bazaar: {
        ...bazaarBase,
        ...(bazaarMeta && { category: bazaarMeta.category, tags: bazaarMeta.tags }),
        discoverable: true,
      }},
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(routes as any, resourceServer as any) as any;
}
