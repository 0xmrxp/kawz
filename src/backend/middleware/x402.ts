// x402 payment middleware — seller-side via @x402/hono.
// Phase 1: dev-mode pass-through (no payment check).
// Phase 2: wire real paymentMiddleware with x402ResourceServer + CDP facilitator.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import type { Variables } from "../types";

export interface X402Config {
  env: Env;
  routePrices: Record<string, string>; // path → atomicUsdc amount
}

// Returns a Hono middleware that enforces x402 payment on every matched request.
// In development mode the check is bypassed so routes are directly testable.
export function createX402Middleware(config: X402Config): MiddlewareHandler {
  const isDev = config.env.ENVIRONMENT !== "production";

  if (isDev) {
    return async (_c, next) => next();
  }

  // Phase 2 implementation:
  // import { paymentMiddleware } from "@x402/hono";
  // const facilitatorUrl = config.env.CDP_API_KEY_ID
  //   ? "https://api.cdp.coinbase.com/platform/v2/x402"
  //   : "https://x402.org/facilitator";
  // const x402Routes = buildX402RoutesConfig(config.routePrices, config.env.EVM_PAYEE_ADDRESS);
  // const x402Server = createX402ResourceServer({ facilitatorUrl, ... });
  // return paymentMiddleware(x402Routes, x402Server);

  return async (_c, next) => next(); // placeholder until Phase 2
}
