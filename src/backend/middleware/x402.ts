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
import { createAuthHeader, createCorrelationHeader } from "@coinbase/x402";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_PATH = "/platform/v2/x402";
const CDP_URL  = `https://${CDP_HOST}${CDP_PATH}`;

// @coinbase/x402 v0.3.0 bug: createCdpAuthHeaders() returns only {verify, settle}.
// HTTPFacilitatorClient.getSupported() calls createAuthHeaders("supported") and gets
// {} back (undefined key), so the Authorization header is missing → CDP 401.
// This function generates the JWT for all three operations explicitly.
function buildCdpAuthHeaders(apiKeyId: string, apiKeySecret: string) {
  return async () => {
    const make = async (op: string) => ({
      Authorization: await createAuthHeader(apiKeyId, apiKeySecret, CDP_HOST, `${CDP_PATH}/${op}`),
      "Correlation-Context": createCorrelationHeader(),
    });
    return {
      verify:    await make("verify"),
      settle:    await make("settle"),
      supported: await make("supported"),
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
};

const ROUTE_DESCRIPTIONS: Record<string, string> = {
  "/api/v1/trading/engine/vitals":            "Live BTC/ETH price, 24h change and volume from Binance.",
  "/api/v1/trading/engine/orderbook-depth":   "CEX orderbook bids/asks, spread and imbalance for a trading pair.",
  "/api/v1/trading/engine/mev-risk-index":    "MEV sandwich attack risk score 0-100 for the current Base block.",
  "/api/v1/trading/engine/funding-rates":     "Perpetual futures funding rates for BTC, ETH, SOL from Binance Futures.",
  "/api/v1/trading/engine/whale-tracker":     "Recent USDC transfers on Base above $500K via Blockscout.",
  "/api/v1/coding/cache/dependency-tree":     "Parse import/export dependency graph from JavaScript or TypeScript source.",
  "/api/v1/coding/cache/token-compressor":    "Strip comments and whitespace from source code to minimize LLM token usage.",
  "/api/v1/coding/cache/syntax-heartbeat":    "Validate JavaScript/TypeScript/JSX syntax and return parse errors.",
  "/api/v1/coding/cache/refactor-suggest":    "LLM-powered refactoring suggestions with severity ratings.",
  "/api/v1/coding/cache/security-audit":      "Static security audit — detect SQL injection, XSS, hardcoded secrets.",
  "/api/v1/analysis/memory/heartbeat":        "Cosine similarity between two texts using BGE-base-en-v1.5 embeddings.",
  "/api/v1/analysis/memory/entity-extractor": "Extract named entities (people, orgs, dates, locations, money) from text.",
  "/api/v1/analysis/memory/context-ranker":   "Re-rank text chunks by semantic relevance to a query using BGE embeddings.",
  "/api/v1/analysis/memory/bias-detector":    "Detect framing bias, sentiment slant, and loaded language in text.",
  "/api/v1/analysis/memory/fact-linkage":     "Verify claims via Google Fact Check API with LLM fallback.",
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
    const method  = methodForPath(path);
    const bazaar  = BAZAAR_META[path];

    routes[`${method} ${path}`] = {
      accepts: [{
        payTo:   env.EVM_PAYEE_ADDRESS,
        scheme:  "exact",
        price:   `$${pricing.usdAmount}`,
        network,
      }],
      description: ROUTE_DESCRIPTIONS[path],
      mimeType: "application/json",
      ...(bazaar && {
        extensions: {
          bazaar: { discoverable: true, ...bazaar },
        },
      }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(routes as any, resourceServer as any) as any;
}
