// MPP payment middleware — Tempo only, via mppx/hono.
//
// EVM x402 (exact scheme, Base USDC) is handled by @x402/hono in x402.ts.
// This middleware handles Tempo (pathUSD, chainId 4217) as a second payment option.
// Registered after createX402Middleware in server.ts.

import { Mppx } from "mppx/hono";
import { tempo } from "mppx/server";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

export function createMppMiddleware(env: Env): MiddlewareHandler {
  const isPaymentEnabled =
    env.ENVIRONMENT === "production" || process.env.FORCE_PAYMENT === "true";

  if (!isPaymentEnabled) {
    return async (_c, next) => next();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mppx = (Mppx as any).create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    methods: [(tempo as any)({
      currency:  env.MPP_TEMPO_USDC_ADDRESS,
      recipient: env.EVM_PAYEE_ADDRESS,
    })],
    realm:     new URL(env.BASE_URL).host,
    secretKey: env.MPP_SECRET_KEY,
  });

  return async (c, next) => {
    const rawPath    = c.req.path;
    const lookupPath = rawPath.startsWith("/v1/") ? `/api${rawPath}` : rawPath;
    const pricing    = ROUTE_PRICE_MAP[lookupPath];
    if (!pricing) return next();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chargeHandler = (mppx as any).charge({ amount: pricing.usdAmount }) as MiddlewareHandler;
    return chargeHandler(c, next);
  };
}
