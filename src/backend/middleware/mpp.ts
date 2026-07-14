// MPP payment middleware — seller-side via mppx.
// Phase 1: dev-mode pass-through.
// Phase 2: wire real Mppx.create() + tempo() with verified mppx API.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

export interface MppConfig {
  env: Env;
}

export function createMppMiddleware(config: MppConfig): MiddlewareHandler {
  const isDev = config.env.ENVIRONMENT !== "production";

  if (isDev) {
    return async (_c, next) => next();
  }

  // Phase 2 implementation:
  // import { Mppx } from "mppx/hono";  -- or "mppx/proxy", verify at Phase 2
  // import { tempo } from "mppx/server";
  // const mppx = Mppx.create({
  //   methods: [tempo({ currency: config.env.MPP_TEMPO_USDC_ADDRESS, recipient: config.env.EVM_PAYEE_ADDRESS })],
  //   realm: config.env.BASE_URL,
  //   secretKey: config.env.MPP_SECRET_KEY,
  // });
  // return async (c, next) => {
  //   const price = ROUTE_PRICE_MAP[c.req.path]?.atomicUsdc ?? "0";
  //   const result = await mppx.charge({ amount: price })(c.req.raw);
  //   if (result.status === 402) return result.challenge as Response;
  //   return next();
  // };

  return async (_c, next) => next();
}
