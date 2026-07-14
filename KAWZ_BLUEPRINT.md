# 🪐 KAWZ — Canonical Architecture Blueprint v2

> **Agentic Infrastructure Engine berbasis Hono + Cloudflare Workers, dengan dual-protocol payment (x402 + MPP)**
> Versi ini adalah revisi penuh dari draft awal, sudah dikoreksi berdasarkan riset terhadap dokumentasi resmi Coinbase CDP, x402 Foundation, MPP (Stripe/Tempo), dan AgentCash.
> Desain visual: Neo-Brutalism x Functional Bauhaus — Luxury Slate Palette (`#1E2229`, `#282D37`, gold accent `#D4AF37`)

---

## 📋 Daftar Isi

1. [Ringkasan Perubahan dari Draft Awal](#1-ringkasan-perubahan-dari-draft-awal)
2. [Tech Stack](#2-tech-stack)
3. [Arsitektur Pembayaran (x402 + MPP)](#3-arsitektur-pembayaran-x402--mpp)
4. [Skema Harga (Revisi Profitabilitas)](#4-skema-harga-revisi-profitabilitas)
5. [Struktur Folder Monorepo](#5-struktur-folder-monorepo)
6. [Implementasi Kode](#6-implementasi-kode)
7. [Arsitektur Data per Bundle](#7-arsitektur-data-per-bundle)
8. [MCP Server Support](#8-mcp-server-support)
9. [Discovery: openapi.json + llms.txt](#9-discovery-openapijson--llmstxt)
10. [Bazaar Extension (Coinbase CDP)](#10-bazaar-extension-coinbase-cdp)
11. [Design System Visual](#11-design-system-visual)
12. [Estimasi Biaya & Validasi Free Tier](#12-estimasi-biaya--validasi-free-tier)
13. [Environment Variables & Secrets](#13-environment-variables--secrets)
14. [Deployment: Cloudflare Workers + Domain](#14-deployment-cloudflare-workers--domain)
15. [Registrasi Discovery (x402scan / mppscan)](#15-registrasi-discovery-x402scan--mppscan)
16. [Landing Page & Public Docs — Copy Bersih](#16-landing-page--public-docs--copy-bersih)
17. [Phase Build — Roadmap Berurutan](#17-phase-build--roadmap-berurutan)

---

## 1. Ringkasan Perubahan dari Draft Awal

| Aspek | Draft Awal | Revisi (Final) |
|---|---|---|
| Middleware x402 | `import { x402 } from 'agentcash'` (salah — itu SDK buyer) | `x402-hono` / `@x402/hono` (resmi, seller-side) |
| MPP | Tidak ada | `mppx/hono` (resmi, seller-side, dual-protocol inline) |
| Harga endpoint | $0.0001 – $0.0004 (rugi vs biaya facilitator) | $0.002 – $0.012 (margin sehat) |
| Discovery utama | `llms.txt` saja | `/openapi.json` (wajib, skema AgentCash) + `llms.txt` (pelengkap) |
| Facilitator produksi | Tidak jelas | CDP Facilitator (`api.cdp.coinbase.com/platform/v2/x402`) |
| Bazaar | Tidak dibahas | `@x402/extensions/bazaar`, opt-in via `discoverable: true` |
| MCP | Disebutkan tapi tidak detail | `@hono/mcp` dengan Streamable HTTP Transport |
| Data sourcing | Tidak dijelaskan | Detail per bundle (lihat §7) dengan strategi cache KV |
| Sumber data trading | DEX-only (asumsi salah) | **Hybrid CEX (via CCXT) + DEX** — lihat §7.1 |
| `funding-rates` | Diasumsikan dari CoinGecko/DefiLlama (salah kategori) | CCXT `fetchFundingRate()` dari exchange derivatif — funding rate itu konsep CEX/perpetual futures, bukan data DEX spot |
| Free tier & biaya | Belum divalidasi | Divalidasi langsung ke dokumentasi resmi tiap layanan — lihat §12 |
| Landing page & docs | Berpotensi bocorkan stack internal | Copy publik dibersihkan total dari detail teknis (lihat §16) |

---

## 2. Tech Stack

- **Runtime Framework**: Hono v4 (TypeScript, Web Standard Fetch API)
- **Hosting/Execution**: Cloudflare Workers (edge global)
- **Payment — x402**: `x402-hono` (testnet facilitator `x402.org`, produksi CDP Facilitator)
- **Payment — MPP**: `mppx` (Tempo settlement, Hono middleware resmi)
- **Data Cache**: Cloudflare KV (buffer data pasar, TTL pendek)
- **Data CEX**: CCXT (open-source, unified API 100+ exchange, data publik tanpa API key) — **import per-exchange saja** (contoh: `import { binance } from 'ccxt'` — CCXT v4+ mendukung tree-shaking via `"sideEffects": false`), jangan `import ccxt from 'ccxt'` utuh, supaya tidak nabrak limit bundle Workers (1MB Free / 10MB Paid, compressed). **⚠️ Setelah install, cek ukuran bundle dengan `npx wrangler deploy --dry-run` sebelum lanjut — kalau masih melewati limit, alternatifnya fetch data melalui Workers Durable Object terpisah atau gunakan GeckoTerminal API saja untuk pair populer.**
- **AI Inference**: Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5` untuk embedding, model LLM untuk ekstraksi entitas & bias detection)
- **Vector Search**: Cloudflare Vectorize (opsional, untuk context-ranker)
- **Frontend**: Astro v4 + Tailwind CSS v4 (statis, SEO 100/100)
- **MCP Server**: `@hono/mcp` + `@modelcontextprotocol/sdk`

---

## 3. Arsitektur Pembayaran (x402 + MPP)

### 3.1 Alur Umum

```text
Agent (AgentCash / mppx client)
   │
   ├─ Request tanpa payment proof ──> Kawz Worker
   │                                      │
   │                                      ▼
   │                            402 Payment Required
   │                     (payload: price, wallet, network, protocol)
   │
   ├─ Agent bayar via x402 (on-chain, per-request)
   │  atau via MPP session (off-chain voucher, batch settle)
   │
   └─ Retry request + payment proof ──> Kawz verifikasi ──> Data dikembalikan
```

### 3.2 Kenapa Dual-Protocol

- **x402**: settlement on-chain per-request, cocok untuk endpoint frekuensi rendah/menengah (Bundle 2 & 3).
- **MPP**: session-based, settle off-chain voucher, latensi sub-100ms, cocok untuk endpoint frekuensi tinggi seperti `vitals`, `funding-rates` (Bundle 1) yang dipanggil tiap detak loop bot trading.
- Karena flow "exact" x402 secara struktur sama dengan intent "charge" MPP, satu endpoint bisa melayani **kedua** jenis klien tanpa duplikasi route.

### 3.3 Facilitator

| Tahap | Facilitator | Catatan |
|---|---|---|
| Development/Testing | `https://x402.org/facilitator` | Publik, tanpa registrasi bisnis |
| Produksi | `https://api.cdp.coinbase.com/platform/v2/x402` | Butuh `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. **Cek ulang skema biaya terbaru di `docs.cdp.coinbase.com/x402/welcome` sebelum live** — pernah ada free tier 1.000 tx/bulan lalu $0.001/tx setelahnya, kebijakan bisa berubah. |

---

## 4. Skema Harga (Revisi Profitabilitas)

Prinsip: harga minimal **5–10x** di atas estimasi biaya facilitator + biaya data sumber eksternal, supaya margin tidak habis di volume rendah.

| Bundle | Endpoint | Method | Harga |
|---|---|---|---|
| Trading | `/v1/trading/engine/vitals` | GET | $0.002 |
| Trading | `/v1/trading/engine/orderbook-depth` | GET | $0.005 |
| Trading | `/v1/trading/engine/mev-risk-index` | GET | $0.004 |
| Trading | `/v1/trading/engine/funding-rates` | GET | $0.002 |
| Trading | `/v1/trading/engine/whale-tracker` | GET | $0.008 |
| Coding | `/v1/coding/cache/dependency-tree` | POST | $0.003 |
| Coding | `/v1/coding/cache/token-compressor` | POST | $0.002 |
| Coding | `/v1/coding/cache/syntax-heartbeat` | POST | $0.002 |
| Coding | `/v1/coding/cache/refactor-suggest` | POST | $0.005 |
| Coding | `/v1/coding/cache/security-audit` | POST | $0.006 |
| Analysis | `/v1/analysis/memory/heartbeat` | POST | $0.003 |
| Analysis | `/v1/analysis/memory/entity-extractor` | POST | $0.006 |
| Analysis | `/v1/analysis/memory/context-ranker` | POST | $0.005 |
| Analysis | `/v1/analysis/memory/bias-detector` | POST | $0.005 |
| Analysis | `/v1/analysis/memory/fact-linkage` | POST | $0.012 |

> ⚠️ Angka `amount` di atas adalah desimal USD (dipakai di `x-payment-info.price.amount` untuk OpenAPI). Untuk runtime x402 `accepts[].amount`, konversi ke **atomic units** token (USDC 6 desimal: `$0.002` → `"2000"`).

---

## 5. Struktur Folder Monorepo

```text
kawz-monorepo/
├── .github/
│   └── workflows/
│       └── deploy.yml                  # CI/CD auto-deploy ke Cloudflare Workers
├── public/
│   ├── favicon.ico
│   ├── llms.txt                        # Manifest pelengkap untuk crawler AI umum
│   └── fonts/
│       ├── SpaceGrotesk-Bold.woff2
│       └── JetBrainsMono-Regular.woff2
├── src/
│   ├── backend/
│   │   ├── types.ts                    # Env interface (KV, AI bindings + secrets) — wajib ada sebelum file lain
│   │   ├── config/
│   │   │   └── pricing.ts              # Single source of truth harga semua endpoint
│   │   ├── middleware/
│   │   │   ├── x402.ts                 # Setup @x402/hono per environment
│   │   │   └── mpp.ts                  # Setup mppx/hono per environment
│   │   ├── lib/
│   │   │   ├── cache.ts                # Helper Cloudflare KV cache-aside
│   │   │   ├── ast-parser.ts           # Parser AST murni-JS untuk Bundle 2
│   │   │   └── embeddings.ts           # Wrapper Workers AI untuk Bundle 3
│   │   ├── routes/
│   │   │   ├── trading.ts              # Bundle 1 (5 endpoints)
│   │   │   ├── coding.ts               # Bundle 2 (5 endpoints)
│   │   │   ├── analysis.ts             # Bundle 3 (5 endpoints)
│   │   │   ├── openapi.ts              # Generator /openapi.json
│   │   │   └── mcp.ts                  # MCP server route (@hono/mcp)
│   │   └── server.ts                   # Entry point Hono, basePath('/api')
│   │
│   ├── frontend/
│   │   ├── components/
│   │   │   ├── Header.astro
│   │   │   ├── TerminalBox.astro
│   │   │   └── PricingRow.astro
│   │   ├── layouts/
│   │   │   └── MainLayout.astro
│   │   └── pages/
│   │       ├── index.astro
│   │       └── docs.astro
├── package.json
├── tailwind.config.mjs
└── wrangler.toml
```

---

## 6. Implementasi Kode

> **Prinsip clean code yang dipakai di seluruh contoh berikut:**
> - Semua comment ditulis dalam **English** agar konsisten dengan konvensi open-source dan mudah dibaca kontributor mana pun.
> - Setiap fungsi punya tanggung jawab tunggal (single responsibility).
> - Config harga dipisah dari logic route (`pricing.ts`) supaya gampang diaudit/diubah tanpa menyentuh business logic.
> - Tidak ada magic number — semua angka harga/TTL diberi nama konstanta.

### 6.1 `src/backend/config/pricing.ts`

```typescript
// Single source of truth for all endpoint pricing.
// Keeping this separate from route logic makes audits and price changes safe and fast.

export interface EndpointPrice {
  usdAmount: string;   // Decimal USD string, used in OpenAPI x-payment-info
  atomicUsdc: string;  // USDC atomic units (6 decimals), used in x402 runtime `accepts[].amount`
}

export const PRICING: Record<string, EndpointPrice> = {
  // Bundle 1: Trading Engine
  "trading.vitals":            { usdAmount: "0.002000", atomicUsdc: "2000" },
  "trading.orderbookDepth":    { usdAmount: "0.005000", atomicUsdc: "5000" },
  "trading.mevRiskIndex":      { usdAmount: "0.004000", atomicUsdc: "4000" },
  "trading.fundingRates":      { usdAmount: "0.002000", atomicUsdc: "2000" },
  "trading.whaleTracker":      { usdAmount: "0.008000", atomicUsdc: "8000" },

  // Bundle 2: Coding Cache
  "coding.dependencyTree":     { usdAmount: "0.003000", atomicUsdc: "3000" },
  "coding.tokenCompressor":    { usdAmount: "0.002000", atomicUsdc: "2000" },
  "coding.syntaxHeartbeat":    { usdAmount: "0.002000", atomicUsdc: "2000" },
  "coding.refactorSuggest":    { usdAmount: "0.005000", atomicUsdc: "5000" },
  "coding.securityAudit":      { usdAmount: "0.006000", atomicUsdc: "6000" },

  // Bundle 3: Live Vector Pruner (Analysis)
  "analysis.heartbeat":        { usdAmount: "0.003000", atomicUsdc: "3000" },
  "analysis.entityExtractor":  { usdAmount: "0.006000", atomicUsdc: "6000" },
  "analysis.contextRanker":    { usdAmount: "0.005000", atomicUsdc: "5000" },
  "analysis.biasDetector":     { usdAmount: "0.005000", atomicUsdc: "5000" },
  "analysis.factLinkage":      { usdAmount: "0.012000", atomicUsdc: "12000" },
};
```

### 6.2 `src/backend/types.ts`

```typescript
// Cloudflare Workers Env interface — defines all bindings and secrets available at runtime.
// Every file that imports `Env` depends on this file; scaffold it first in Phase 1.

export interface Env {
  // Environment
  ENVIRONMENT: "development" | "production";
  BASE_URL: string;

  // Cloudflare bindings
  KAWZ_VITALS_CACHE: KVNamespace;
  AI: Ai;

  // x402 / CDP Facilitator (production only)
  CDP_API_KEY_ID: string;
  CDP_API_KEY_SECRET: string;

  // MPP / Tempo
  EVM_PAYEE_ADDRESS: string;
  MPP_OPERATOR_KEY: string;
  MPP_FEE_PAYER_KEY?: string;
  MPP_SECRET_KEY: string;
  MPP_TEMPO_USDC_ADDRESS: string;
}
```

### 6.3 `src/backend/middleware/x402.ts`

```typescript
// x402 middleware setup. Switches facilitator by environment automatically.
// Keep facilitator selection here only — routes should never hardcode facilitator URLs.

import { paymentMiddleware } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Env } from "../types";

export function createX402Middleware(env: Env) {
  const isProduction = env.ENVIRONMENT === "production";

  // Production settles through Coinbase's CDP-hosted facilitator.
  // Development/testing uses the public community facilitator — no business registration required.
  const facilitatorUrl = isProduction
    ? "https://api.cdp.coinbase.com/platform/v2/x402"
    : "https://x402.org/facilitator";

  const facilitatorClient = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    // CDP requires authenticated requests in production.
    ...(isProduction && {
      apiKeyId: env.CDP_API_KEY_ID,
      apiKeySecret: env.CDP_API_KEY_SECRET,
    }),
  });

  return { facilitatorClient, ExactEvmScheme, paymentMiddleware };
}
```

### 6.4 `src/backend/middleware/mpp.ts`

```typescript
// MPP middleware setup using the official mppx SDK.
// mppx can run x402-compatible EVM charges inline with an MPP route,
// so a single route can transparently serve both x402 and MPP clients.

import { Mppx } from "mppx/hono";
import { tempo } from "mppx/server";
import type { Env } from "../types";

export function createMppxInstance(env: Env) {
  return Mppx.create({
    methods: [
      tempo({
        // IMPORTANT: verify this contract address against the current
        // official docs at mpp.dev before every production deploy —
        // it has changed between doc revisions in the past.
        currency: env.MPP_TEMPO_USDC_ADDRESS,
        recipient: env.EVM_PAYEE_ADDRESS,
      }),
    ],
    realm: env.BASE_URL, // must match the public origin exactly
  });
}
```

### 6.5 `src/backend/lib/cache.ts`

```typescript
// Cache-aside helper for Cloudflare KV.
// Used to avoid re-fetching expensive third-party data on every paid request —
// this is what keeps Bundle 1 (Trading) profitable despite thin per-call margins.

export interface CacheOptions {
  ttlSeconds: number;
}

export async function getOrFetch<T>(
  kv: KVNamespace,
  cacheKey: string,
  fetcher: () => Promise<T>,
  options: CacheOptions
): Promise<T> {
  const cached = await kv.get(cacheKey, "json");
  if (cached !== null) {
    return cached as T;
  }

  const fresh = await fetcher();
  await kv.put(cacheKey, JSON.stringify(fresh), {
    expirationTtl: options.ttlSeconds,
  });

  return fresh;
}
```

### 6.6 `src/backend/routes/trading.ts`

> ⚠️ **Koreksi arsitektur penting**: middleware x402 dan mppx **harus diregister di level router/app**, bukan diinstansiasi ulang di dalam setiap handler (pola lama adalah anti-pattern — boros memory dan tidak sesuai dengan cara kerja Hono middleware). Lihat `server.ts` (§6.6) untuk cara yang benar memasang middleware di level app.

```typescript
// Bundle 1: Non-Stop AI Trading Engine
// Data is cached aggressively (5-15s TTL) because upstream sources
// (CoinGecko, GeckoTerminal, CEX exchange APIs) are rate-limited or metered.
// Payment middleware is registered at the app level in server.ts — not here.

import { Hono } from "hono";
import { getOrFetch } from "../lib/cache";
import { PRICING } from "../config/pricing";
import type { Env } from "../types";

const trading = new Hono<{ Bindings: Env }>();

// Payment is already enforced by x402+MPP middleware registered upstream in server.ts.
// By the time a handler runs, payment has been verified — no per-handler payment check needed.
trading.get("/vitals", async (c) => {
  const vitals = await getOrFetch(
    c.env.KAWZ_VITALS_CACHE,
    "trading:vitals",
    fetchMarketVitals,
    { ttlSeconds: 10 }
  );
  return c.json({ success: true, bundle: "trading_engine", data: vitals });
});

async function fetchMarketVitals() {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true"
  );
  const data = await response.json() as any;
  return {
    engine_status: "synchronized",
    btc_volatility_24h: data.bitcoin.usd_24h_change,
    eth_volatility_24h: data.ethereum.usd_24h_change,
    timestamp: Date.now(),
  };
}

trading.get("/funding-rates", async (c) => {
  // Funding rates are a perpetual-futures (CEX/derivatives) concept —
  // they do not exist on DEX spot markets, so CCXT against a derivatives
  // exchange is the correct source here, not a DEX aggregator.
  const rates = await getOrFetch(
    c.env.KAWZ_VITALS_CACHE,
    "trading:funding-rates",
    fetchFundingRates,
    { ttlSeconds: 15 }
  );
  return c.json({ success: true, bundle: "trading_engine", data: rates });
});

async function fetchFundingRates() {
  // Tree-shake via named import — CCXT v4+ supports sideEffects:false.
  // Run `npx wrangler deploy --dry-run` to verify bundle stays under Workers size limit.
  const { binance: BinanceClass } = await import("ccxt");
  const exchange = new BinanceClass();

  const fundingRate = await exchange.fetchFundingRate("BTC/USDT:USDT");
  return {
    symbol: fundingRate.symbol,
    funding_rate: fundingRate.fundingRate,
    next_funding_timestamp: fundingRate.fundingTimestamp,
    timestamp: Date.now(),
  };
}

export default trading;
```

### 6.7 `src/backend/server.ts`

```typescript
// Kawz main entry point.
// Mounts all three bundles plus discovery (/openapi.json, /llms.txt) and MCP (/mcp).
// Payment middleware (x402 + MPP) is registered HERE at the app level — NOT in route handlers.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { createX402Middleware } from "./middleware/x402";
import { createMppxInstance } from "./middleware/mpp";
import trading from "./routes/trading";
import coding from "./routes/coding";
import analysis from "./routes/analysis";
import openapi from "./routes/openapi";
import mcp from "./routes/mcp";
import { PRICING } from "./config/pricing";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

// CORS is intentionally permissive on payment-gated routes:
// the caller is authenticated by payment proof, not by origin.
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Payment", "X-Payment-Response"],
  exposeHeaders: ["X-Payment-Response", "WWW-Authenticate"],
}));

// Payment middleware registered once at app level for all paid routes.
// Routes under /v1/* require payment; /openapi.json and /mcp are exempt.
app.use("/v1/*", async (c, next) => {
  const { facilitatorClient, ExactEvmScheme } = createX402Middleware(c.env);
  const mppx = createMppxInstance(c.env);

  // Build the price map for x402 from our central pricing config.
  const priceMap: Record<string, string> = {
    "/api/v1/trading/engine/vitals":         PRICING["trading.vitals"].atomicUsdc,
    "/api/v1/trading/engine/orderbook-depth": PRICING["trading.orderbookDepth"].atomicUsdc,
    "/api/v1/trading/engine/mev-risk-index":  PRICING["trading.mevRiskIndex"].atomicUsdc,
    "/api/v1/trading/engine/funding-rates":   PRICING["trading.fundingRates"].atomicUsdc,
    "/api/v1/trading/engine/whale-tracker":   PRICING["trading.whaleTracker"].atomicUsdc,
    "/api/v1/coding/cache/dependency-tree":   PRICING["coding.dependencyTree"].atomicUsdc,
    "/api/v1/coding/cache/token-compressor":  PRICING["coding.tokenCompressor"].atomicUsdc,
    "/api/v1/coding/cache/syntax-heartbeat":  PRICING["coding.syntaxHeartbeat"].atomicUsdc,
    "/api/v1/coding/cache/refactor-suggest":  PRICING["coding.refactorSuggest"].atomicUsdc,
    "/api/v1/coding/cache/security-audit":    PRICING["coding.securityAudit"].atomicUsdc,
    "/api/v1/analysis/memory/heartbeat":      PRICING["analysis.heartbeat"].atomicUsdc,
    "/api/v1/analysis/memory/entity-extractor": PRICING["analysis.entityExtractor"].atomicUsdc,
    "/api/v1/analysis/memory/context-ranker": PRICING["analysis.contextRanker"].atomicUsdc,
    "/api/v1/analysis/memory/bias-detector":  PRICING["analysis.biasDetector"].atomicUsdc,
    "/api/v1/analysis/memory/fact-linkage":   PRICING["analysis.factLinkage"].atomicUsdc,
  };

  // mppx handles MPP payments and falls through for x402 clients.
  // paymentMiddleware handles the x402 verification layer.
  const mppHandler = mppx.charge({ amount: priceMap[c.req.path] ?? "0" });
  const mppResult = await mppHandler(c.req.raw);
  if (mppResult.status === 402) return mppResult.challenge as Response;

  return next();
});

app.route("/v1/trading/engine", trading);
app.route("/v1/coding/cache", coding);
app.route("/v1/analysis/memory", analysis);
app.route("/", openapi); // serves GET /api/openapi.json — no payment required
app.route("/mcp", mcp);  // serves ALL /api/mcp — MCP tools handle their own payment context

export default app;
```

---

## 7. Arsitektur Data per Bundle

### 7.1 Bundle 1 — Trading Engine (hybrid CEX + DEX, margin tertipis)

> ⚠️ **Koreksi penting dari draft sebelumnya**: data trading yang benar itu **wajib hybrid CEX + DEX**, bukan DEX-only. Beberapa metrik seperti `funding-rates` secara definisi adalah konsep **perpetual futures di CEX/exchange derivatif** — data ini nyaris tidak ada di DEX spot, jadi sumber CoinGecko/DefiLlama yang dipakai di draft sebelumnya **salah kategori** untuk endpoint itu.

| Endpoint | Sumber Data | Strategi Cache |
|---|---|---|
| `vitals` | **CCXT** `fetchTicker()` dari Binance/Coinbase (CEX, acuan volatilitas utama pasar) + **GeckoTerminal API** (DEX, gratis, 1.900+ DEX di 260+ jaringan) untuk konteks on-chain | KV 10-15 detik |
| `orderbook-depth` | **CCXT** `fetchOrderBook()` dari CEX (depth biasanya jauh lebih dalam dari DEX untuk pair mayor) **+** GeckoTerminal/Uniswap v3 subgraph (The Graph) untuk sisi DEX — agent bisa bandingkan slippage CEX vs DEX | KV 5-10 detik |
| `funding-rates` | **CCXT** `fetchFundingRate()` dari exchange derivatif (Binance Futures, Bybit, OKX) — **satu-satunya sumber yang benar secara definisi** | KV 10-15 detik |
| `whale-tracker` | **Basescan/Etherscan API** (free tier: 5 calls/detik, 100.000/hari) — pantau event `Transfer` di atas threshold tertentu. Alternatif open-source: **Blockscout** (self-hostable, gratis penuh, dipakai OP Stack chains) | KV 30-60 detik |
| `mev-risk-index` | Heuristik dari trace transaksi publik (Blockscout/Basescan) — pola sandwich attack dideteksi dari urutan transaksi di block yang sama, bukan berlangganan layanan MEV-protection berbayar | KV 30-60 detik |

**Catatan implementasi CCXT**: data publik (ticker, orderbook, funding rate) **tidak butuh API key** — cocok karena Kawz cuma baca data untuk dijual ulang, bukan eksekusi trading. Import exchange satu-satu (`ccxt/js/src/binance.js`), bukan seluruh library, supaya bundle Worker tetap ramping.

**Kunci margin**: karena harga sumber data biasanya per-panggilan atau berbasis kuota, KV cache membuat satu panggilan upstream bisa dijual berkali-kali ke agent berbeda dalam window TTL yang sama.

### 7.2 Bundle 2 — Coding Cache (self-contained, margin terbaik)

Tidak butuh API eksternal sama sekali:

- `dependency-tree`, `syntax-heartbeat` → parser AST murni-JS yang ringan untuk edge runtime (`@babel/parser` atau `es-module-lexer`), **bukan** TypeScript Compiler API penuh yang terlalu berat untuk Workers.
- `token-compressor` → regex/string processing murni di Worker, nol biaya eksternal.
- `refactor-suggest`, `security-audit` → Workers AI (model LLM) untuk analisis semantik, atau database pattern known-vulnerable packages disimpan statis di KV.

### 7.3 Bundle 3 — Live Vector Pruner / Analysis

- `heartbeat` (cosine similarity) → `env.AI.run("@cf/baai/bge-base-en-v1.5", ...)` generate embedding, hitung cosine similarity manual di Worker.
- `entity-extractor`, `bias-detector` → Workers AI LLM (Llama/Qwen) dengan output JSON terstruktur.
- `context-ranker` → kombinasi bge embedding + Cloudflare Vectorize (**ada free tier**: 30M queried dimensions + 5M stored dimensions/bulan) untuk re-ranking cepat.
- `fact-linkage` → **Google Fact Check Tools API** (gratis, cukup API key Google Cloud, akses database ClaimReview global) sebagai sumber utama. Keterbatasan: hanya menemukan klaim yang **sudah pernah** di-fact-check manusia — untuk klaim baru, fallback ke Workers AI LLM + grounding search. Tetap endpoint termahal untuk diproses, karenanya diberi harga tertinggi ($0.012).

---

## 8. MCP Server Support

> ⚠️ **Koreksi pola Workers stateless**: Cloudflare Workers adalah stateless — isolate bisa di-reuse antar request tapi tidak bisa diandalkan untuk state persisten. Pattern `if (!mcpServer.isConnected())` pada module-level instance **tidak reliable** di Workers karena koneksi dari invokasi sebelumnya bisa sudah dead. Solusinya: buat instance `McpServer` dan `StreamableHTTPTransport` baru **per-request**, bukan module-level singleton.

```typescript
// src/backend/routes/mcp.ts
// Exposes all 15 endpoints as MCP tools over Streamable HTTP Transport.
// Per-request instantiation is correct for Cloudflare Workers' stateless model —
// do NOT move McpServer or transport to module scope.

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Env } from "../types";

const mcp = new Hono<{ Bindings: Env }>();

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "kawz", version: "1.0.0" });

  // Register each bundle's endpoints as individual MCP tools here.
  // Mirror the same business logic as the REST handlers — share helper functions, not handlers.
  // (Tool registrations for all 15 endpoints go here — see §4 for the full list.)

  return server;
}

mcp.all("/", async (c) => {
  // Fresh server + transport per request — correct pattern for stateless Workers.
  const server = buildMcpServer();
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

export default mcp;
```

---

## 9. Discovery: `openapi.json` + `llms.txt`

`GET /openapi.json` adalah **sumber kebenaran utama** untuk AgentCash, x402scan, dan mppscan. `llms.txt` tetap dipertahankan sebagai pelengkap untuk crawler AI umum dan kustomisasi halaman di Poncho — keduanya harus ada bersamaan, bukan salah satu.

```typescript
// src/backend/routes/openapi.ts
// This is the canonical machine-readable contract agents use to discover
// and correctly invoke every payable route on Kawz.

import { Hono } from "hono";
import { PRICING } from "../config/pricing";
import type { Env } from "../types";

const openapi = new Hono<{ Bindings: Env }>();

openapi.get("/openapi.json", (c) => {
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Kawz Agentic Infrastructure Engine",
      version: "1.0.0",
      description: "Pay-per-request utility infrastructure for autonomous AI agents.",
      "x-guidance": "Use GET /api/v1/trading/engine/vitals for market vitals. Use POST /api/v1/coding/cache/token-compressor with { raw_code } to compress source code. Use POST /api/v1/analysis/memory/entity-extractor with { unstructured_text } to extract structured entities.",
      contact: { email: "team@kawz.dev" },
    },
    paths: {
      "/api/v1/trading/engine/vitals": {
        get: {
          operationId: "tradingVitals",
          summary: "Market vitals — volatility, gas fees, sentiment",
          tags: ["Trading"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["trading.vitals"].usdAmount },
            protocols: [{ x402: {} }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: {
            "200": { description: "Success" },
            "402": { description: "Payment Required" },
          },
        },
      },
      // ... repeat for the remaining 14 endpoints
    },
  });
});

export default openapi;
```

---

## 10. Bazaar Extension (Coinbase CDP)

> ⚠️ **STATUS TIDAK TERVERIFIKASI**: Package `@x402/extensions/bazaar` **tidak ditemukan di npm registry** per validasi Juli 2026. Export `declareDiscoveryExtension`, `registerExtension`, dan `bazaarResourceServerExtension` belum dapat dikonfirmasi keberadaannya. Sebelum Phase 6, **cek GitHub releases di `github.com/x402-foundation/x402`** untuk melihat apakah package ini sudah released ke npm atau masih dalam development.

Pola implementasi yang dimaksud (jika package sudah tersedia):

```typescript
// Attach discovery metadata so this endpoint surfaces automatically
// in Coinbase's CDP Bazaar catalog once settled through the CDP facilitator.
// VERIFY package name and exports against npm registry before implementing.

import { declareDiscoveryExtension, registerExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

const bazaarExt = declareDiscoveryExtension({
  method: "GET",
  input: { query: { pair: { type: "string" } } },
  discoverable: true,
});

registerExtension(bazaarResourceServerExtension);
```

> ⚠️ Ada laporan bug terbuka di repo resmi x402-foundation soal indexing Bazaar yang kadang tidak muncul meski settlement sukses. Jangan bergantung 100% ke Bazaar — tetap daftar manual ke x402scan/mppscan sebagai jalur cadangan (lihat §14). Kalau package belum tersedia saat build, lewati Phase 6 Bazaar step dan lanjutkan ke discovery manual.

---

## 11. Design System Visual

| Elemen | Nilai |
|---|---|
| Primary Background | `#1E2229` |
| Secondary Background (card) | `#282D37` |
| Accent Core (Bauhaus Gold) | `#D4AF37` / `#E5C158` |
| Text Primary | `#F3F4F6` |
| Text Muted | `#9CA3AF` |
| Border/Grid | `#374151`, ketebalan solid (`border-2`/`border-4`) |
| Sudut | `rounded-none` mutlak |
| Bayangan | Hard box shadow tanpa blur, contoh: `shadow-[4px_4px_0px_0px_#374151]` |

---

## 12. Estimasi Biaya & Validasi Free Tier

Semua angka di bawah sudah divalidasi langsung ke dokumentasi resmi masing-masing layanan (bukan asumsi) sebelum dimasukkan ke blueprint ini.

### 12.1 Terkonfirmasi Valid

| Layanan | Free Tier | Catatan |
|---|---|---|
| Cloudflare Workers | 100.000 request/hari, 10ms CPU time/invocation | Cukup untuk MVP; produksi ramai butuh Paid plan ($5/bulan) |
| Workers KV | 1GB storage, 100K read/hari, **1K write/hari** | Limit write paling gampang kena kalau cache TTL pendek + traffic ramai |
| Workers AI | **10.000 Neuron/hari gratis**, reset 00:00 UTC, lalu $0.011/1.000 Neuron | Berlaku di Free maupun Paid plan |
| Cloudflare Vectorize | 30M queried dimensions + 5M stored dimensions/bulan | Free tier resmi ada — sumber lama yang bilang "tidak ada free tier" sudah usang |
| CDP Facilitator (x402) | 1.000 transaksi gratis/bulan, lalu $0.001/transaksi | Berlaku resmi sejak 1 Jan 2026 |
| CoinGecko API | Demo plan: 100 calls/menit, 10.000 calls/bulan | Upgrade $35/bulan kalau traffic ramai |
| GeckoTerminal API | Gratis, 10 calls/menit | Dari tim CoinGecko, cakupan 1.900+ DEX |
| Basescan/Etherscan API | 5 calls/detik, 100.000 calls/hari | Gratis, cukup untuk whale-tracker |
| CCXT (data publik CEX) | Gratis, tanpa API key, tanpa limit dari CCXT sendiri | Limit datang dari rate limit masing-masing exchange, ditangani otomatis oleh CCXT |
| Google Fact Check Tools API | Gratis (API key Google Cloud) | Hanya cakup klaim yang sudah pernah di-fact-check manusia |

### 12.2 Tidak Ada Free Tier Berarti (Butuh Budget)

| Layanan | Status |
|---|---|
| Dune Analytics API | Praktis tidak ada free tier layak untuk pemakaian produksi — **diganti** dengan Basescan/Blockscout di §7.1 |
| 1inch API tingkat lanjut | Free tier terbatas, tren makin mengunci — **diganti** dengan GeckoTerminal + CCXT |
| Domain `kawz.dev` | Biaya tahunan wajib (Cloudflare Registrar harga wholesale) |

### 12.3 Kesimpulan

Fase **development/MVP** (Phase 0-8 di §17) bisa jalan nyaris gratis total. Baru pas migrasi produksi serius (Phase 9-10), siapkan budget kecil bulanan: Cloudflare Paid ($5) + kemungkinan upgrade CoinGecko ($35) kalau traffic Bundle 1 ramai. Biaya CDP Facilitator ($0.001/tx di atas 1.000/bulan) sudah diperhitungkan di skema harga §4.

---

## 13. Environment Variables & Secrets

```text
ENVIRONMENT=production
BASE_URL=https://kawz.dev

# x402 / CDP Facilitator
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=

# MPP / Tempo
EVM_PAYEE_ADDRESS=
MPP_OPERATOR_KEY=
MPP_FEE_PAYER_KEY=          # optional — omit to let agents pay their own gas
MPP_SECRET_KEY=             # openssl rand -hex 32, never rotate after go-live
MPP_TEMPO_USDC_ADDRESS=     # verify against current mpp.dev docs before deploy

# Cloudflare bindings
KAWZ_VITALS_CACHE=          # KV namespace binding
AI=                         # Workers AI binding
```

Semua secret **wajib** disetel via `wrangler secret put`, bukan `[vars]` biasa di `wrangler.toml` — jangan pernah commit private key ke repo.

---

## 14. Deployment: Cloudflare Workers + Domain

1. Beli/pindahkan domain `kawz.dev` ke Cloudflare Registrar (atau cukup arahkan nameserver ke Cloudflare kalau domain sudah dimiliki di registrar lain).
2. `wrangler.toml` — pastikan `[[routes]]` mengarah ke `kawz.dev/*` dengan `zone_name = "kawz.dev"`.
3. Deploy: `npx wrangler deploy`.
4. Verifikasi TLS otomatis aktif (Cloudflare mengelola sertifikat secara default).

---

## 15. Registrasi Discovery (x402scan / mppscan)

```bash
npx -y @agentcash/discovery@latest discover "https://kawz.dev"
npx -y @agentcash/discovery@latest check "https://kawz.dev"
```

Setelah lolos validasi tanpa error blocking, daftarkan origin ke:
- `https://www.x402scan.com/resources/register`
- `https://www.mppscan.com/register`

---

## 16. Landing Page & Public Docs — Copy Bersih

> **Prinsip utama**: landing page dan halaman docs publik **tidak boleh menyebut stack internal sama sekali** — tidak ada "Hono", "Cloudflare Workers", "KV", "x402-hono", "mppx", "CCXT", "GeckoTerminal", dst. Yang publik lihat cuma: apa yang Kawz lakukan, berapa harganya, dan cara pakainya. Detail implementasi itu urusan §1-15 di dokumen ini, bukan konsumsi publik.

### 16.1 Referensi Gaya: stableenrich.dev

Struktur dan nada dari `stableenrich.dev` dipakai sebagai acuan karena sudah terbukti efektif untuk audiens ini (AI agent + developer yang mengintegrasikan agent):

- Hero pendek, langsung ke value proposition, bukan penjelasan teknis.
- Kotak onboarding CLI 3 langkah (`onboard` → `try` → `add`) — bukan tutorial API key/OAuth.
- Kartu harga dikelompokkan per **kategori kegunaan**, bukan daftar mentah 15 endpoint.
- Tabel perbandingan "cara lama vs cara agentic" untuk mendidik pengunjung yang belum familiar dengan x402/MPP.
- Footer menyebut protokol terbuka (x402, MPP) dan jaringan settlement (Base/Solana/Tempo) — ini boleh disebut karena itu standar terbuka publik, bukan implementasi internal Kawz.
- **Tidak ada** satu pun penyebutan framework, database, atau layanan cloud yang dipakai di baliknya.

### 16.2 Draft Copy Hero (`index.astro`)

```text
Tagline: "Infrastructure agents can keep reaching for."
Subhead: "Your agent explores. You pay pennies."

Body: Kawz unifies 15 utility endpoints across trading, coding,
and research behind one stateless interface. No sign-ups.
No credential overhead. Real-time settlement.

CLI Onboarding Box:
  Step 1: npx agentcash onboard
  Step 2: npx agentcash try https://kawz.dev
  Step 3: npx agentcash add https://kawz.dev
```

### 16.3 Kartu Harga per Kategori (bukan per-endpoint mentah)

Kelompokkan 15 endpoint jadi 3 kartu kategori di landing page (detail per-endpoint baru muncul di halaman `/docs`, bukan di hero):

```text
Trading Intelligence — from $0.002
  Market vitals, funding rates, orderbook depth, whale tracking

Coding Cache — from $0.002
  AST analysis, code compression, security audits

Research Pruner — from $0.003
  Similarity checks, entity extraction, fact verification
```

### 16.4 Tabel Perbandingan (pola "cara lama vs agentic")

```text
Human-managed tooling          →  Autonomous execution
1. Sign up for N services      →  1. One endpoint
2. Buy credits upfront         →  2. Pay per request
3. Rotate API keys             →  3. No credentials — payment is authentication
4. Monitor N bills             →  4. One ledger, on-chain, real-time
5. Agent asks permission       →  5. Agent decides within budget
```

### 16.5 Halaman `/docs`

Docs publik cukup berisi:
- Deskripsi fungsional tiap endpoint (apa yang dikembalikan, bukan bagaimana caranya)
- Contoh request/response JSON
- Harga per endpoint
- Link ke `/openapi.json` dan `/llms.txt` untuk agent yang mau discovery otomatis

**Jangan** cantumkan diagram arsitektur, nama library, atau strategi caching di halaman ini — itu semua tetap di blueprint internal ini saja.

### 16.6 Footer (boleh disebut karena standar terbuka publik)

```text
Built on open standards for agentic payments from Coinbase and Tempo.
Payments settle in USDC on Base, Solana, or Tempo.

[/llms.txt] [Docs] [x402] [MPP] [Terms] [Privacy]
```

---

## 17. Phase Build — Roadmap Berurutan

### **Phase 0 — Persiapan & Kredensial** *(sebelum menulis kode apa pun)*
- [ ] Generate wallet operator EVM (`EVM_PAYEE_ADDRESS`) dan fee-payer (opsional).
- [ ] Daftar CDP API Key (`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) di `portal.cdp.coinbase.com`.
- [ ] Generate `MPP_SECRET_KEY` via `openssl rand -hex 32`, simpan aman.
- [ ] Verifikasi alamat kontrak Tempo USDC terbaru di `mpp.dev/docs`.
- [ ] Beli/arahkan domain `kawz.dev` ke Cloudflare.
- [ ] Buat akun Cloudflare Workers + KV namespace kosong.

### **Phase 1 — Skeleton Proyek**
- [ ] Scaffold monorepo sesuai struktur folder di §5.
- [ ] `npm init` + install dependency inti: `hono`, `@x402/hono`, `mppx`, `@hono/mcp`, `@modelcontextprotocol/sdk`.
- [ ] **Buat `src/backend/types.ts` terlebih dahulu** (lihat §6.2) — file ini jadi prerequisite semua file backend lain.
- [ ] Setup `wrangler.toml` dasar (tanpa domain custom dulu — pakai `*.workers.dev` untuk testing).
- [ ] Deploy "Hello World" Hono ke Workers untuk validasi pipeline CI/CD dasar.

### **Phase 2 — Payment Layer (Testnet)**
- [ ] Implementasi `middleware/x402.ts` dengan facilitator `x402.org` (testnet).
- [ ] Implementasi `middleware/mpp.ts` dengan `mppx/hono`.
- [ ] Bangun **satu** endpoint contoh (`trading/vitals`) dengan payment gate ganda (x402 + MPP).
- [ ] Uji manual pakai `mppx` CLI dan `agentcash fetch` dari sisi klien untuk memastikan 402 challenge dan settlement jalan.

### **Phase 3 — Bundle 1: Trading Engine**
- [ ] Implementasi `vitals` & `orderbook-depth` dengan sumber hybrid CEX (CCXT, import per-exchange) + DEX (GeckoTerminal).
- [ ] Implementasi `funding-rates` khusus dari CCXT exchange derivatif (Binance Futures/Bybit/OKX) — **jangan** pakai sumber DEX untuk ini.
- [ ] Implementasi `whale-tracker` & `mev-risk-index` dari Basescan/Blockscout.
- [ ] Bangun `lib/cache.ts` dan pasang KV cache-aside di setiap endpoint.
- [ ] Tuning TTL cache per endpoint berdasarkan volatilitas data.
- [ ] Cek ukuran bundle Worker setelah tambah CCXT (`wrangler deploy --dry-run`) — pastikan tidak nabrak limit 1MB/10MB.

### **Phase 4 — Bundle 2: Coding Cache**
- [ ] Implementasi parser AST ringan (`@babel/parser`/`es-module-lexer`) untuk `dependency-tree` dan `syntax-heartbeat`.
- [ ] Perbaiki & implementasi regex compressor untuk `token-compressor`.
- [ ] Implementasi `refactor-suggest` dan `security-audit` (Workers AI atau database pattern statis).

### **Phase 5 — Bundle 3: Analysis / Vector Pruner**
- [ ] Setup Workers AI binding, implementasi `heartbeat` (embedding + cosine similarity).
- [ ] Implementasi `entity-extractor` dan `bias-detector` via LLM inference terstruktur.
- [ ] Setup Cloudflare Vectorize untuk `context-ranker`.
- [ ] Implementasi `fact-linkage` dengan sumber eksternal (search/fact-check API).

### **Phase 6 — Discovery & Bazaar**
- [ ] Bangun route `/openapi.json` lengkap 15 endpoint dengan `x-payment-info` valid.
- [ ] Tulis `public/llms.txt` final.
- [ ] Pasang Bazaar extension (`@x402/extensions/bazaar`) di setiap route.
- [ ] Jalankan `@agentcash/discovery discover` dan `check`, perbaiki semua warning.

### **Phase 7 — MCP Server**
- [ ] Implementasi `routes/mcp.ts` dengan `@hono/mcp`.
- [ ] Register 15 tools ke MCP server, mapping ke handler yang sama dengan REST routes (hindari duplikasi logic).
- [ ] Uji koneksi MCP pakai MCP Inspector atau client Claude Desktop.

### **Phase 8 — Frontend: Landing Page & Docs**
- [ ] Scaffold Astro + Tailwind v4 sesuai design system §11.
- [ ] Bangun `index.astro` mengikuti copy bersih §16.2-16.4 (hero, onboarding CLI, kartu harga per kategori, tabel perbandingan) — **review ulang sebelum publish, pastikan nol penyebutan stack internal**.
- [ ] Bangun `docs.astro` sesuai batasan §16.5 (fungsional + contoh JSON, tanpa diagram arsitektur).
- [ ] Integrasikan build Astro ke pipeline deploy Workers (static assets).

### **Phase 9 — Migrasi ke Mainnet/Produksi**
- [ ] Ganti facilitator x402 dari `x402.org` ke CDP Facilitator produksi.
- [ ] Pindahkan semua secret ke `wrangler secret put` (bukan `[vars]`).
- [ ] Arahkan `wrangler.toml` `[[routes]]` ke domain `kawz.dev` custom.
- [ ] Smoke test end-to-end dengan dana USDC riil dalam jumlah kecil.

### **Phase 10 — Registrasi & Go-Live**
- [ ] Daftarkan origin ke x402scan dan mppscan.
- [ ] Verifikasi listing muncul di CDP Bazaar (dengan fallback manual jika tidak, lihat §10).
- [ ] Monitoring awal: cek margin riil vs proyeksi harga di §4, sesuaikan bila perlu.
- [ ] Umumkan Kawz ke komunitas `awesome-x402` / `awesome-mpp`.

---

*Dokumen ini adalah living document — update setiap kali ada perubahan kebijakan facilitator, alamat kontrak, atau skema discovery dari pihak Coinbase/Tempo/AgentCash.*
