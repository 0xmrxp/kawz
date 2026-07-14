// x402 payment middleware — seller-side via @x402/hono v2.
// Uses paymentMiddleware + Resource (the documented v2 API) which automatically
// registers EVM scheme implementations — no manual scheme import needed.
// Set FORCE_PAYMENT=true to enable in dev/testnet without ENVIRONMENT=production.

import { paymentMiddleware, Resource } from "@x402/hono";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const TESTNET_FACILITATOR = "https://x402.org/facilitator";
const PROD_FACILITATOR   = "https://api.cdp.coinbase.com/platform/v2/x402";

export function createX402Middleware(env: Env): MiddlewareHandler {
  const isPaymentEnabled =
    env.ENVIRONMENT === "production" || process.env.FORCE_PAYMENT === "true";

  if (!isPaymentEnabled) {
    return async (_c, next) => next();
  }

  const isProd = env.ENVIRONMENT === "production" && !!env.CDP_API_KEY_ID;
  const facilitatorUrl = isProd ? PROD_FACILITATOR : TESTNET_FACILITATOR;
  const network        = isProd ? "base" : "base-sepolia";

  const resources = Object.entries(ROUTE_PRICE_MAP).map(([path, pricing]) =>
    Resource(path, {
      price:   `$${pricing.usdAmount}`,
      network,
      payTo:   env.EVM_PAYEE_ADDRESS,
    })
  );

  // paymentMiddleware handles EVM scheme registration internally
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return paymentMiddleware(resources, { url: facilitatorUrl }) as any;
}
