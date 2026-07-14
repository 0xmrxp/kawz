// x402 payment middleware — seller-side via @x402/hono v2.
// Includes @x402/extensions/bazaar for endpoint discoverability in CDP Bazaar catalog.

import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const TESTNET_FACILITATOR = "https://x402.org/facilitator";
const PROD_FACILITATOR   = "https://api.cdp.coinbase.com/platform/v2/x402";

const TESTNET_NETWORK = "eip155:84532";
const MAINNET_NETWORK = "eip155:8453";

function methodForPath(path: string): "GET" | "POST" {
  return path.includes("/trading/") ? "GET" : "POST";
}

// Human-readable description for each route — surfaced in Bazaar discovery catalog.
const ROUTE_DESCRIPTIONS: Record<string, string> = {
  "/api/v1/trading/engine/vitals":            "Live BTC/ETH price, 24h change, volume, and engine status from Binance.",
  "/api/v1/trading/engine/orderbook-depth":   "CEX orderbook bids/asks, spread, depth, and imbalance for a trading pair.",
  "/api/v1/trading/engine/mev-risk-index":    "MEV sandwich attack risk score (0-100) for the current Base block.",
  "/api/v1/trading/engine/funding-rates":     "Perpetual futures funding rates for BTC, ETH, SOL from Binance Futures.",
  "/api/v1/trading/engine/whale-tracker":     "Recent large USDC transfers on Base above $500K via Blockscout.",
  "/api/v1/coding/cache/dependency-tree":     "Parse import/export dependency graph from JavaScript or TypeScript source.",
  "/api/v1/coding/cache/token-compressor":    "Strip comments and whitespace from source code to minimize LLM token usage.",
  "/api/v1/coding/cache/syntax-heartbeat":    "Validate JavaScript/TypeScript/JSX syntax and return parse errors.",
  "/api/v1/coding/cache/refactor-suggest":    "LLM-powered refactoring suggestions with severity ratings.",
  "/api/v1/coding/cache/security-audit":      "Static security audit — detect SQL injection, XSS, hardcoded secrets, and more.",
  "/api/v1/analysis/memory/heartbeat":        "Cosine similarity between two texts using BAAI/bge-base-en-v1.5 embeddings.",
  "/api/v1/analysis/memory/entity-extractor": "Extract named entities (people, orgs, dates, locations, money) from text.",
  "/api/v1/analysis/memory/context-ranker":   "Re-rank text chunks by semantic relevance to a query using BGE embeddings.",
  "/api/v1/analysis/memory/bias-detector":    "Detect framing bias, sentiment slant, and loaded language in text.",
  "/api/v1/analysis/memory/fact-linkage":     "Verify claims via Google Fact Check API with Groq LLM fallback.",
};

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resourceServer = (new x402ResourceServer(facilitatorClient) as any)
    .register(network, new ExactEvmScheme());

  // Register Bazaar discovery extension so CDP catalogs these endpoints.
  if (typeof resourceServer.registerExtension === "function") {
    resourceServer.registerExtension(bazaarResourceServerExtension);
  }

  const routes: Record<string, { accepts: unknown[]; description?: string }> = {};
  for (const [path, pricing] of Object.entries(ROUTE_PRICE_MAP)) {
    const method = methodForPath(path);
    routes[`${method} ${path}`] = {
      accepts: [{
        payTo:   env.EVM_PAYEE_ADDRESS,
        scheme:  "exact",
        price:   `$${pricing.usdAmount}`,
        network,
      }],
      description: ROUTE_DESCRIPTIONS[path],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(routes as any, resourceServer as any) as any;
}
