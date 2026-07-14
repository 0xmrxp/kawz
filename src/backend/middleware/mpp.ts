// Unified payment middleware — mppx handles both EVM x402 (Base USDC) and Tempo.
//
// Uses mppx/server Mppx.create() directly (not mppx/hono) because the Hono
// wrapper strips compose(). We call compose() per-request, then wrap with the
// payment() adapter from mppx/hono to get a Hono MiddlewareHandler.
//
// EVM path:   evm.charge() + x402 facilitator → Base USDC, eip155:8453
// Tempo path: tempo.charge() → Tempo pathUSD, chainId 4217
// Client pays with whichever method it supports.

import { Mppx } from "mppx/server";
import { evm, tempo } from "mppx/server";
import { payment } from "mppx/hono";
import { createCorrelationHeader } from "@coinbase/x402";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_PATH = "/platform/v2/x402";
const CDP_URL  = `https://${CDP_HOST}${CDP_PATH}`;

// Wraps globalThis.fetch with CDP JWT auth for every call to /verify or /settle.
function createCdpFetch(apiKeyId: string, apiKeySecret: string) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const op = url.endsWith("/verify") ? "verify" : "settle";
    const jwt = await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: "POST",
      requestHost:   CDP_HOST,
      requestPath:   `${CDP_PATH}/${op}`,
    });
    return globalThis.fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> ?? {}),
        "Authorization":        `Bearer ${jwt}`,
        "Correlation-Context":  createCorrelationHeader(),
        "Content-Type":         "application/json",
      },
    });
  };
}

export function createMppMiddleware(env: Env): MiddlewareHandler {
  const isPaymentEnabled =
    env.ENVIRONMENT === "production" || process.env.FORCE_PAYMENT === "true";

  if (!isPaymentEnabled) {
    return async (_c, next) => next();
  }

  const isProd = env.ENVIRONMENT === "production" && !!env.CDP_API_KEY_ID;

  // ── EVM x402 method (Base mainnet USDC) ───────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evmMethod = (evm as any).charge({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    currency:  (evm as any).assets.base.USDC,   // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
    recipient: env.EVM_PAYEE_ADDRESS,
    x402: {
      facilitator: isProd ? CDP_URL : "https://x402.org/facilitator",
      ...(isProd ? { fetch: createCdpFetch(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) } : {}),
    },
  });

  // ── Tempo method (pathUSD, chainId 4217) ──────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tempoMethod = (tempo as any)({
    currency:  env.MPP_TEMPO_USDC_ADDRESS,
    recipient: env.EVM_PAYEE_ADDRESS,
  });

  // Use mppx/server Mppx (has compose()). Hono wrapper strips compose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coreMppx = (Mppx as any).create({
    methods: [evmMethod, tempoMethod],
    realm:     new URL(env.BASE_URL).host,
    secretKey: env.MPP_SECRET_KEY,
  });

  // Per-request: compose both methods for this amount, wrap with Hono payment adapter.
  // compose([fn, opts], [fn, opts]) returns a single handler that accepts either method.
  return async (c, next) => {
    const rawPath    = c.req.path;
    const lookupPath = rawPath.startsWith("/v1/") ? `/api${rawPath}` : rawPath;
    const pricing    = ROUTE_PRICE_MAP[lookupPath];
    if (!pricing) return next();

    const opts = { amount: pricing.usdAmount };

    // compose() accepts payment from either EVM or Tempo — client picks what it can pay.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composed = coreMppx.compose(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [coreMppx["evm/charge"],   opts],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [coreMppx["tempo/charge"], opts],
    );

    const handler = payment(composed, {}) as MiddlewareHandler;
    return handler(c, next);
  };
}
