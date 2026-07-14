// x402 payment middleware — seller-side via @x402/hono.
// Uses paymentMiddlewareFromConfig which creates x402ResourceServer internally.
// Set FORCE_PAYMENT=true to enable in dev/testnet without ENVIRONMENT=production.

import { paymentMiddlewareFromConfig } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const TESTNET_FACILITATOR = "https://x402.org/facilitator";
const PROD_FACILITATOR   = "https://api.cdp.coinbase.com/platform/v2/x402";

// Base Sepolia testnet CAIP-2; Base mainnet for production
const TESTNET_NETWORK = "eip155:84532";
const MAINNET_NETWORK = "eip155:8453";

// Determine HTTP method from route path (all trading = GET, coding/analysis = POST)
function methodForPath(path: string): "GET" | "POST" {
  return path.includes("/trading/") ? "GET" : "POST";
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

  // Build x402 RoutesConfig: keys are "METHOD /full/path"
  const routes: Record<string, unknown> = {};
  for (const [path, pricing] of Object.entries(ROUTE_PRICE_MAP)) {
    const method = methodForPath(path);
    routes[`${method} ${path}`] = {
      accepts: [{
        payTo:  env.EVM_PAYEE_ADDRESS,
        scheme: "exact",
        price:  `$${pricing.usdAmount}`,
        network,
      }],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddlewareFromConfig(routes as any, facilitatorClient as any);
}
