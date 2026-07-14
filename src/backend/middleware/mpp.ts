// MPP payment middleware — seller-side via mppx.
// Mppx.create() returns an instance where charge() returns a Hono MiddlewareHandler.
// We wrap it at the app level by looking up price per request path.
// Set FORCE_PAYMENT=true to enable in dev/testnet without ENVIRONMENT=production.

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

  // Mppx.create() returns a wrapped instance where every intent method
  // (charge, session) returns a Hono MiddlewareHandler ready for app.use().
  const mppx = Mppx.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    methods: [(tempo as any)({
      currency:  env.MPP_TEMPO_USDC_ADDRESS, // USDC contract on Base
      recipient: env.EVM_PAYEE_ADDRESS,
    })],
    realm:     new URL(env.BASE_URL).host,  // "lobre.lat" — hostname only, no scheme
    secretKey: env.MPP_SECRET_KEY,
  });

  // App-level wrapper: look up atomicUsdc amount for the request path,
  // then delegate to mppx.charge() which returns the per-route MiddlewareHandler.
  return async (c, next) => {
    // c.req.path is basePath-relative (/v1/...) but map keys are /api/v1/...
    const rawPath = c.req.path;
    const lookupPath = rawPath.startsWith("/v1/") ? `/api${rawPath}` : rawPath;
    const pricing = ROUTE_PRICE_MAP[lookupPath];
    if (!pricing) return next(); // path not in price map → pass through

    // mppx.charge() returns a MiddlewareHandler — call it directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chargeHandler = (mppx as any).charge({ amount: pricing.atomicUsdc }) as MiddlewareHandler;
    return chargeHandler(c, next);
  };
}
