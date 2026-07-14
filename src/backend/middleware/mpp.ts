// Unified payment middleware — mppx handles both EVM x402 (Base USDC) and Tempo.
//
// Uses mppx/server Mppx.create() to retain compose(). Calls compose() per-request
// and handles the result directly — bypassing mppx/hono's payment() adapter which
// expects intent(options)(request) style, incompatible with compose() output.
//
// EVM path:   evm.charge() + x402 facilitator → Base USDC, eip155:8453
// Tempo path: tempo.charge() → Tempo pathUSD, chainId 4217
// compose() accepts payment from either method — client picks whichever it supports.

import { Mppx } from "mppx/server";
import { evm, tempo } from "mppx/server";
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
    currency:  (evm as any).assets.base.USDC,
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

  // mppx/server Mppx retains compose() — hono wrapper strips it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coreMppx = (Mppx as any).create({
    methods: [evmMethod, tempoMethod],
    realm:     new URL(env.BASE_URL).host,
    secretKey: env.MPP_SECRET_KEY,
  });

  // Per-request: compose returns async (request) => result directly.
  // Call it with c.req.raw — no wrapper needed. Handle 402 and receipt manually.
  return async (c, next) => {
    const rawPath    = c.req.path;
    const lookupPath = rawPath.startsWith("/v1/") ? `/api${rawPath}` : rawPath;
    const pricing    = ROUTE_PRICE_MAP[lookupPath];
    if (!pricing) return next();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const composed = coreMppx.compose(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [coreMppx["evm/charge"],   { amount: pricing.usdAmount }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [coreMppx["tempo/charge"], { amount: pricing.usdAmount }],
    );

    // compose(request) → { status, challenge } | { status, withReceipt }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await composed(c.req.raw);

    if (result.status === 402) return result.challenge;

    await next();
    c.res = result.withReceipt(c.res);
  };
}
