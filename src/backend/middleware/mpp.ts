// Unified payment middleware — mppx handles both EVM x402 (Base USDC) and Tempo.
//
// EVM path:   mppx evm.charge() emits x402 v2 payment-required challenge.
//             Clients pay with Base mainnet USDC via EIP-3009 transferWithAuthorization.
//             Settlement: CDP facilitator (prod) or x402.org (dev/testnet).
//
// Tempo path: mppx tempo.charge() emits MPP WWW-Authenticate challenge.
//             Clients pay with Tempo pathUSD (chainId 4217).
//
// mppx.compose() accepts payment from either method — client picks whichever it supports.

import { evm, Mppx, tempo } from "mppx/hono";
import { createCorrelationHeader } from "@coinbase/x402";
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { ROUTE_PRICE_MAP } from "../config/pricing";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_PATH = "/platform/v2/x402";
const CDP_URL  = `https://${CDP_HOST}${CDP_PATH}`;

// Wraps globalThis.fetch to inject CDP JWT auth on every call to the facilitator.
// mppx calls /verify and /settle with plain fetch — this adds the required Authorization header.
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
        Authorization:         `Bearer ${jwt}`,
        "Correlation-Context": createCorrelationHeader(),
        "Content-Type":        "application/json",
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
    currency:  (evm as any).assets.base.USDC,   // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, eip155:8453
    recipient: env.EVM_PAYEE_ADDRESS,
    x402: {
      facilitator: isProd ? CDP_URL : "https://x402.org/facilitator",
      ...(isProd ? { fetch: createCdpFetch(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET) } : {}),
    },
  });

  // ── Tempo method (pathUSD, chainId 4217) ──────────────────────────────────
  // MPP_TEMPO_USDC_ADDRESS = 0x20c0000000000000000000000000000000000000 (pathUSD on Tempo mainnet)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tempoMethod = (tempo as any)({
    currency:  env.MPP_TEMPO_USDC_ADDRESS,
    recipient: env.EVM_PAYEE_ADDRESS,
  });

  const mppx = Mppx.create({
    methods: [evmMethod, tempoMethod],
    realm:     new URL(env.BASE_URL).host,
    secretKey: env.MPP_SECRET_KEY,
  });

  // Per-request wrapper: look up decimal USD amount for the path, then gate.
  // Tempo and EVM amounts are both decimal strings (e.g. "0.030000") — not atomic units.
  return async (c, next) => {
    const rawPath   = c.req.path;
    const lookupPath = rawPath.startsWith("/v1/") ? `/api${rawPath}` : rawPath;
    const pricing   = ROUTE_PRICE_MAP[lookupPath];
    if (!pricing) return next();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (mppx as any).charge({ amount: pricing.usdAmount }) as MiddlewareHandler;
    return handler(c, next);
  };
}
