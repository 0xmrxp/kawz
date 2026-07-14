# Lobre — Canonical Architecture Blueprint v3

> **Agentic Infrastructure Engine berbasis Hono + VPS Linux, dengan dual-protocol payment (x402 + MPP)**
> Versi ini adalah revisi penuh dari Blueprint v2 (Cloudflare Workers), dimigrasi ke hosting VPS Linux penuh dengan domain `lobre.lat`.
> Stack: Bun · Hono · Redis · Groq API · Qdrant · Caddy · PM2
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
14. [Deployment: VPS Linux + Caddy + PM2](#14-deployment-vps-linux--caddy--pm2)
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
| **Hosting** | Cloudflare Workers (edge serverless) | **VPS Linux (self-hosted penuh)** — lebih fleksibel, bisa CCXT tanpa bundle size limit, kontrol penuh atas Redis/Qdrant |
| **Cache** | Cloudflare KV | **Redis** (self-hosted di VPS) |
| **AI Inference** | Workers AI | **Groq API** (free tier cepat) + `@xenova/transformers` lokal untuk embedding |
| **Vector DB** | Cloudflare Vectorize | **Qdrant** (self-hosted Docker, gratis penuh) |
| **Reverse proxy + TLS** | Cloudflare auto | **Caddy** (auto HTTPS via Let's Encrypt, zero-config) |
| **Process manager** | wrangler / edge isolate | **PM2** (Node.js/Bun process manager, restart otomatis) |
| **Nama & domain** | KAWZ / kawz.dev | **Lobre / lobre.lat** |

---

## 2. Tech Stack

| Layer | Teknologi | Catatan |
|---|---|---|
| **Runtime server** | **Bun** (TypeScript-native, Web Standard Fetch API) | Hono punya first-class Bun adapter; lebih cepat dari Node.js untuk I/O-heavy workload |
| **Framework** | **Hono v4** | Tidak berubah dari v2 — API-compatible, cukup ganti entry point `serve()` |
| **Hosting** | **VPS Linux** (Ubuntu 22.04 LTS direkomendasikan) | Full self-hosted, tidak ada vendor lock-in Cloudflare |
| **Reverse proxy + TLS** | **Caddy** | Auto HTTPS via Let's Encrypt, zero-config; lebih simpel dari Nginx + Certbot |
| **Process manager** | **PM2** | Restart otomatis, cluster mode, log management |
| **Payment — x402** | `@x402/hono` (testnet: `x402.org`, produksi: CDP Facilitator) | Tidak berubah |
| **Payment — MPP** | `mppx` / `mppx/hono` (Tempo settlement) | Tidak berubah |
| **Data Cache** | **Redis** (self-hosted di VPS, `ioredis`) | Menggantikan Cloudflare KV; API hampir identik untuk pola cache-aside |
| **Data CEX** | **CCXT** (full import, tidak ada bundle size limit di VPS) | Di VPS tidak ada limit 1MB/10MB seperti Workers — `import ccxt from 'ccxt'` aman |
| **AI Inference — LLM** | **Ollama** (self-hosted, `Qwen2.5-3B-Instruct` GGUF Q4_K_M, ~2 GB RAM) **+ Groq API** (cloud fallback, `llama-3.3-70b-versatile`) | Ollama jalan di CPU lokal VPS, tanpa API key, nol biaya; Groq fallback otomatis jika Ollama down (`GROQ_API_KEY` opsional) |
| **AI Inference — Embedding** | **`@xenova/transformers`** (model `BAAI/bge-base-en-v1.5`) | Jalan di CPU lokal, tanpa API key, tanpa biaya eksternal — cocok untuk VPS |
| **Vector DB** | **Qdrant** (Docker, self-hosted di VPS) | Gratis penuh, gRPC + REST API, high-performance |
| **Frontend** | **Astro v4 + Tailwind CSS v4** (statis, SEO 100/100) | Build output disajikan sebagai static files via Caddy |
| **MCP Server** | `@hono/mcp` + `@modelcontextprotocol/sdk` | Tidak berubah |
| **CI/CD** | **GitHub Actions** → deploy via SSH ke VPS | `appleboy/ssh-action` atau custom rsync + PM2 reload |

---

## 3. Arsitektur Pembayaran (x402 + MPP)

### 3.1 Alur Umum

```text
Agent (AgentCash / mppx client)
   │
   ├─ Request tanpa payment proof ──> Lobre server (VPS / Bun + Hono)
   │                                      │
   │                                      ▼
   │                            402 Payment Required
   │                     (payload: price, wallet, network, protocol)
   │
   ├─ Agent bayar via x402 (on-chain, per-request)
   │  atau via MPP session (off-chain voucher, batch settle)
   │
   └─ Retry request + payment proof ──> Lobre verifikasi ──> Data dikembalikan
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
lobre-monorepo/
├── .github/
│   └── workflows/
│       └── deploy.yml                  # CI/CD: build + SSH deploy ke VPS via appleboy/ssh-action
├── infra/
│   ├── Caddyfile                       # Reverse proxy + auto HTTPS (Let's Encrypt) untuk lobre.lat
│   ├── ecosystem.config.cjs            # PM2 process config (app name, script, env vars)
│   └── docker-compose.yml             # Qdrant + Redis container di VPS
├── public/
│   ├── favicon.ico
│   ├── llms.txt                        # Manifest pelengkap untuk crawler AI umum
│   └── fonts/
│       ├── SpaceGrotesk-Bold.woff2
│       └── JetBrainsMono-Regular.woff2
├── src/
│   ├── backend/
│   │   ├── types.ts                    # Env interface (Redis URL, Groq key, secrets) — wajib ada sebelum file lain
│   │   ├── config/
│   │   │   └── pricing.ts              # Single source of truth harga semua endpoint
│   │   ├── middleware/
│   │   │   ├── x402.ts                 # Setup @x402/hono per environment
│   │   │   └── mpp.ts                  # Setup mppx/hono per environment
│   │   ├── lib/
│   │   │   ├── cache.ts                # Helper Redis cache-aside (ioredis)
│   │   │   ├── ast-parser.ts           # Parser AST untuk Bundle 2
│   │   │   └── embeddings.ts           # Wrapper @xenova/transformers untuk Bundle 3
│   │   ├── routes/
│   │   │   ├── trading.ts              # Bundle 1 (5 endpoints)
│   │   │   ├── coding.ts               # Bundle 2 (5 endpoints)
│   │   │   ├── analysis.ts             # Bundle 3 (5 endpoints)
│   │   │   ├── openapi.ts              # Generator /openapi.json
│   │   │   └── mcp.ts                  # MCP server route (@hono/mcp)
│   │   └── server.ts                   # Entry point Hono + Bun.serve(), port 3000
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
├── bunfig.toml                         # Konfigurasi Bun (scripts, workspace)
└── tailwind.config.mjs
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
// VPS environment config — read from process.env at runtime (via dotenv or PM2 env injection).
// No Cloudflare-specific bindings here: KVNamespace, Ai, etc. diganti dengan string URL/key biasa.
// Every file that imports `Env` depends on this file; scaffold it first in Phase 1.

export interface Env {
  // Environment
  ENVIRONMENT: "development" | "production";
  BASE_URL: string;         // e.g. "https://lobre.lat"
  PORT: string;             // e.g. "3000"

  // Redis (self-hosted on VPS, managed via docker-compose.yml)
  REDIS_URL: string;        // e.g. "redis://localhost:6379"

  // Groq API (LLM inference for Bundle 3 — entity extractor, bias detector)
  GROQ_API_KEY: string;

  // Qdrant (self-hosted on VPS, used by context-ranker endpoint)
  QDRANT_URL: string;       // e.g. "http://localhost:6333"

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

// Read config from process.env — used in server.ts to build the Env object.
export function loadEnv(): Env {
  const required = [
    "BASE_URL", "REDIS_URL", "GROQ_API_KEY", "QDRANT_URL",
    "EVM_PAYEE_ADDRESS", "MPP_SECRET_KEY", "MPP_TEMPO_USDC_ADDRESS",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
  return process.env as unknown as Env;
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
// Cache-aside helper backed by Redis (ioredis).
// Drop-in replacement for the former Cloudflare KV helper — same calling convention,
// but now backed by Redis running locally on the VPS via docker-compose.
// Keeps Bundle 1 (Trading) profitable by spreading one upstream call across many agent requests.

import Redis from "ioredis";

let _redis: Redis | null = null;

// Lazy singleton — connection is reused across requests in the same Bun process.
function getRedis(redisUrl: string): Redis {
  if (!_redis) {
    _redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  }
  return _redis;
}

export interface CacheOptions {
  ttlSeconds: number;
}

export async function getOrFetch<T>(
  redisUrl: string,
  cacheKey: string,
  fetcher: () => Promise<T>,
  options: CacheOptions
): Promise<T> {
  const redis = getRedis(redisUrl);

  const cached = await redis.get(cacheKey);
  if (cached !== null) {
    return JSON.parse(cached) as T;
  }

  const fresh = await fetcher();
  // EX sets TTL in seconds — identical semantics to KV expirationTtl.
  await redis.set(cacheKey, JSON.stringify(fresh), "EX", options.ttlSeconds);

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
    c.env.REDIS_URL,
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
    c.env.REDIS_URL,
    "trading:funding-rates",
    fetchFundingRates,
    { ttlSeconds: 15 }
  );
  return c.json({ success: true, bundle: "trading_engine", data: rates });
});

async function fetchFundingRates() {
  // On VPS there is no 1MB bundle size limit — full CCXT import is fine.
  // Named import still preferred for clarity and faster startup.
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
// Lobre main entry point — Bun standalone server (not a Cloudflare Workers module export).
// `Bun.serve()` replaces `export default app` — this is the key difference from the Workers version.
// Payment middleware (x402 + MPP) is registered HERE at the app level — NOT in route handlers.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { createX402Middleware } from "./middleware/x402";
import { createMppxInstance } from "./middleware/mpp";
import trading from "./routes/trading";
import coding from "./routes/coding";
import analysis from "./routes/analysis";
import openapi from "./routes/openapi";
import mcp from "./routes/mcp";
import { PRICING } from "./config/pricing";
import { loadEnv, type Env } from "./types";

// Load and validate all env vars once at startup — fails fast if anything is missing.
const env = loadEnv();

// On VPS, Hono uses Variables (not Bindings) to pass runtime config through context.
// `c.get("env")` in any route handler returns the fully typed Env object.
type Variables = { env: Env };
const app = new Hono<{ Variables: Variables }>().basePath("/api");

// Inject env into every request context.
app.use("*", (c, next) => { c.set("env", env); return next(); });

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
  const e = c.get("env");
  const mppx = createMppxInstance(e);

  const priceMap: Record<string, string> = {
    "/api/v1/trading/engine/vitals":            PRICING["trading.vitals"].atomicUsdc,
    "/api/v1/trading/engine/orderbook-depth":   PRICING["trading.orderbookDepth"].atomicUsdc,
    "/api/v1/trading/engine/mev-risk-index":    PRICING["trading.mevRiskIndex"].atomicUsdc,
    "/api/v1/trading/engine/funding-rates":     PRICING["trading.fundingRates"].atomicUsdc,
    "/api/v1/trading/engine/whale-tracker":     PRICING["trading.whaleTracker"].atomicUsdc,
    "/api/v1/coding/cache/dependency-tree":     PRICING["coding.dependencyTree"].atomicUsdc,
    "/api/v1/coding/cache/token-compressor":    PRICING["coding.tokenCompressor"].atomicUsdc,
    "/api/v1/coding/cache/syntax-heartbeat":    PRICING["coding.syntaxHeartbeat"].atomicUsdc,
    "/api/v1/coding/cache/refactor-suggest":    PRICING["coding.refactorSuggest"].atomicUsdc,
    "/api/v1/coding/cache/security-audit":      PRICING["coding.securityAudit"].atomicUsdc,
    "/api/v1/analysis/memory/heartbeat":        PRICING["analysis.heartbeat"].atomicUsdc,
    "/api/v1/analysis/memory/entity-extractor": PRICING["analysis.entityExtractor"].atomicUsdc,
    "/api/v1/analysis/memory/context-ranker":   PRICING["analysis.contextRanker"].atomicUsdc,
    "/api/v1/analysis/memory/bias-detector":    PRICING["analysis.biasDetector"].atomicUsdc,
    "/api/v1/analysis/memory/fact-linkage":     PRICING["analysis.factLinkage"].atomicUsdc,
  };

  const mppResult = await mppx.charge({ amount: priceMap[c.req.path] ?? "0" })(c.req.raw);
  if (mppResult.status === 402) return mppResult.challenge as Response;

  return next();
});

app.route("/v1/trading/engine", trading);
app.route("/v1/coding/cache", coding);
app.route("/v1/analysis/memory", analysis);
app.route("/", openapi);
app.route("/mcp", mcp);

// Bun.serve() — this replaces `export default app` from the Cloudflare Workers version.
// Port is read from env; Caddy reverse proxies lobre.lat → localhost:3000.
const port = parseInt(env.PORT ?? "3000");
console.log(`Lobre server running on port ${port}`);
Bun.serve({ port, fetch: app.fetch });
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

**Catatan implementasi CCXT di VPS**: tidak ada bundle size limit di VPS seperti di Cloudflare Workers — `import ccxt from 'ccxt'` atau named import per-exchange sama-sama aman. Data publik (ticker, orderbook, funding rate) **tidak butuh API key**. Import named per-exchange tetap disarankan untuk startup time lebih cepat (`import { binance } from 'ccxt'`).

**Kunci margin**: karena harga sumber data biasanya per-panggilan atau berbasis kuota, KV cache membuat satu panggilan upstream bisa dijual berkali-kali ke agent berbeda dalam window TTL yang sama.

### 7.2 Bundle 2 — Coding Cache (self-contained, margin terbaik)

Tidak butuh API eksternal sama sekali:

- `dependency-tree`, `syntax-heartbeat` → parser AST murni-JS yang ringan untuk edge runtime (`@babel/parser` atau `es-module-lexer`), **bukan** TypeScript Compiler API penuh yang terlalu berat untuk Workers.
- `token-compressor` → regex/string processing murni di Worker, nol biaya eksternal.
- `refactor-suggest`, `security-audit` → Workers AI (model LLM) untuk analisis semantik, atau database pattern known-vulnerable packages disimpan statis di KV.

### 7.3 Bundle 3 — Live Vector Pruner / Analysis

- `heartbeat` (cosine similarity) → **`@xenova/transformers`** jalan lokal di VPS: load model `BAAI/bge-base-en-v1.5` sekali saat startup (model ~400MB, cached di disk), generate embedding di CPU, hitung cosine similarity manual. Tanpa API key, tanpa biaya eksternal, latensi ~50-150ms di CPU VPS standar.
- `entity-extractor`, `bias-detector` → **Ollama** (`lib/llm.ts`, model `qwen2.5:3b` GGUF Q4_K_M): output JSON terstruktur via `response_format: { type: "json_object" }`. Jalan di CPU lokal VPS, tanpa API key. Groq cloud (`llama-3.3-70b-versatile`) otomatis jadi fallback jika Ollama tidak tersedia.
- `context-ranker` → kombinasi bge embedding (`@xenova/transformers`) + **Qdrant** (self-hosted Docker di VPS, REST API port 6333). Qdrant gratis penuh, tidak ada kuota.
- `fact-linkage` → **Google Fact Check Tools API** (gratis, API key Google Cloud, database ClaimReview global) sebagai sumber utama. Keterbatasan: hanya klaim yang **sudah pernah** di-fact-check manusia — untuk klaim baru, fallback ke Groq LLM + grounding search. Tetap endpoint termahal ($0.012) karena gabungan external API call + LLM inference.

**Catatan startup `@xenova/transformers`**: model di-download otomatis pertama kali (`~/.cache/huggingface/hub/`). Gunakan `await pipeline('feature-extraction', 'Xenova/bge-base-en-v1.5')` dan cache instance pipeline di module scope — jangan inisialisasi ulang per request.

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
  const server = new McpServer({ name: "lobre", version: "1.0.0" });

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
      title: "Lobre Agentic Infrastructure Engine",
      version: "1.0.0",
      description: "Pay-per-request utility infrastructure for autonomous AI agents.",
      "x-guidance": "Use GET /api/v1/trading/engine/vitals for market vitals. Use POST /api/v1/coding/cache/token-compressor with { raw_code } to compress source code. Use POST /api/v1/analysis/memory/entity-extractor with { unstructured_text } to extract structured entities.",
      contact: { email: "team@lobre.lat" },
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

### 12.1 Infrastruktur VPS

| Komponen | Biaya | Catatan |
|---|---|---|
| **VPS Linux** (misal: DigitalOcean/Vultr/Hetzner/Contabo) | **$5–$6/bulan** (1 vCPU, 1–2 GB RAM, 25 GB SSD) | Hetzner paling murah (~€3.5/bulan). Cukup untuk MVP. Naik ke $12/bulan (2 vCPU, 4 GB RAM) kalau Redis + Qdrant + Bun butuh lebih room. |
| **Domain `lobre.lat`** | **~$3–$5/tahun** | `.lat` TLD harga murah, beli di Namecheap/Cloudflare Registrar |
| **TLS/HTTPS** | **Gratis** | Caddy auto-renew via Let's Encrypt |
| **Redis** (self-hosted di VPS) | **Gratis** | Jalan di Docker, tidak ada kuota tulis/baca seperti KV |
| **Qdrant** (self-hosted di VPS) | **Gratis** | Docker, REST API, tidak ada kuota dimensions |
| **`@xenova/transformers` embedding** | **Gratis** | Jalan lokal di CPU, model ~400MB, cache di disk |

### 12.2 Layanan Eksternal (Gratis / Berbiaya)

| Layanan | Free Tier | Catatan |
|---|---|---|
| **Ollama** (LLM inference, primary) | **Gratis penuh** — jalan di CPU lokal VPS | Install: `curl -fsSL https://ollama.com/install.sh \| sh` + `ollama pull qwen2.5:3b`; ~2 GB RAM, ~50–200 ms per inferensi di 4 vCPU |
| **Groq API** (LLM cloud fallback) | Free tier: 14.400 req/hari, 6.000 tokens/menit | Opsional — hanya dipakai jika Ollama down; set `GROQ_API_KEY` di `.env` |
| CDP Facilitator (x402) | 1.000 transaksi gratis/bulan, lalu $0.001/transaksi | Berlaku resmi sejak 1 Jan 2026 |
| CoinGecko API | Demo plan: 100 calls/menit, 10.000 calls/bulan | Upgrade $35/bulan kalau traffic ramai |
| GeckoTerminal API | Gratis, 10 calls/menit | Dari tim CoinGecko, 1.900+ DEX |
| Basescan/Etherscan API | 5 calls/detik, 100.000 calls/hari | Gratis, cukup untuk whale-tracker |
| CCXT (data publik CEX) | Gratis, tanpa API key | Limit dari rate limit exchange masing-masing |
| Google Fact Check Tools API | Gratis (API key Google Cloud) | Hanya klaim yang sudah di-fact-check manusia |

### 12.3 Tidak Dipakai (Biaya Tidak Sepadan)

| Layanan | Status |
|---|---|
| Dune Analytics API | Tidak ada free tier layak — **diganti** Basescan/Blockscout |
| 1inch API tingkat lanjut | Free tier makin terbatas — **diganti** GeckoTerminal + CCXT |
| Domain `lobre.lat` | Biaya tahunan wajib (~$3–5/tahun, beli di Namecheap/Cloudflare Registrar) |

### 12.4 Kesimpulan Biaya VPS

Fase **development/MVP** (Phase 0-8): bisa jalan hampir gratis — VPS $5/bulan + domain $5/tahun saja. Produksi serius (Phase 9-10): VPS bisa naik ke $12/bulan kalau butuh lebih resource, tambah upgrade CoinGecko ($35/bulan) kalau traffic Bundle 1 tinggi. Biaya CDP Facilitator ($0.001/tx di atas 1.000/bulan) dan Groq sudah diperhitungkan di skema harga §4.

**Total estimasi MVP**: ~$5–$7/bulan all-in (VPS + domain prorated).

---

## 13. Environment Variables & Secrets

File `.env` di root repo (jangan pernah commit ke git — masuk `.gitignore`):

```text
# App
ENVIRONMENT=production
BASE_URL=https://lobre.lat
PORT=3000

# Redis (self-hosted via docker-compose di VPS)
REDIS_URL=redis://localhost:6379

# Ollama (self-hosted LLM — primary inference engine)
# Install: curl -fsSL https://ollama.com/install.sh | sh
# Pull:    ollama pull qwen2.5:3b
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=qwen2.5:3b

# Groq API (cloud fallback jika Ollama down — opsional)
GROQ_API_KEY=                  # dari console.groq.com

# Qdrant (self-hosted via docker-compose di VPS)
QDRANT_URL=http://localhost:6333

# x402 / CDP Facilitator
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=

# MPP / Tempo
EVM_PAYEE_ADDRESS=
MPP_OPERATOR_KEY=
MPP_FEE_PAYER_KEY=             # optional — omit to let agents pay their own gas
MPP_SECRET_KEY=                # openssl rand -hex 32, never rotate after go-live
MPP_TEMPO_USDC_ADDRESS=        # verify against current mpp.dev docs before deploy
```

Pada VPS, inject via PM2 `ecosystem.config.cjs` (field `env`) atau dengan `dotenv` di entry point. Jangan pernah commit private key atau API key ke repo — gunakan GitHub Actions Secrets untuk CI/CD.

---

## 14. Deployment: VPS Linux + Caddy + PM2

### 14.1 Provisioning VPS

```bash
# Di mesin lokal — SSH ke VPS baru (Ubuntu 22.04 LTS)
ssh root@<VPS_IP>

# Install Bun
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

# Install Docker + Docker Compose (untuk Redis + Qdrant)
apt-get update && apt-get install -y docker.io docker-compose-plugin
systemctl enable --now docker

# Install Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install caddy

# Install PM2
bun install -g pm2
```

### 14.2 Redis + Qdrant via Docker Compose

File `infra/docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:6379:6379"  # bind localhost only, not exposed externally

  qdrant:
    image: qdrant/qdrant:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:6333:6333"
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  qdrant_data:
```

```bash
# Di VPS, jalankan containers
cd /opt/lobre
docker compose -f infra/docker-compose.yml up -d
```

### 14.3 Caddy (Reverse Proxy + Auto HTTPS)

File `infra/Caddyfile`:

```
lobre.lat {
  reverse_proxy localhost:3000
}

www.lobre.lat {
  redir https://lobre.lat{uri} permanent
}
```

```bash
# Copy Caddyfile ke lokasi resmi Caddy
cp infra/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
# Caddy otomatis request + renew sertifikat Let's Encrypt
```

### 14.4 PM2 Process Manager

File `infra/ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [{
    name: "lobre",
    script: "src/backend/server.ts",
    interpreter: "bun",
    interpreter_args: "run",
    env: {
      NODE_ENV: "production",
      // Inject non-secret vars here; secrets via .env file at deploy time
    },
    restart_delay: 3000,
    max_restarts: 10,
    log_file: "/var/log/lobre/app.log",
    error_file: "/var/log/lobre/error.log",
  }]
};
```

```bash
# Start / reload app
pm2 start infra/ecosystem.config.cjs
pm2 save          # persist across reboots
pm2 startup       # generate systemd unit for PM2 itself
```

### 14.5 CI/CD via GitHub Actions (SSH Deploy)

File `.github/workflows/deploy.yml`:

```yaml
name: Deploy to VPS

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/lobre
            git pull origin main
            bun install --frozen-lockfile
            pm2 reload lobre --update-env
```

GitHub Secrets yang perlu diset: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.

### 14.6 DNS Setup

Di registrar domain `lobre.lat`: tambahkan A record:
```
lobre.lat     A    <VPS_IP>
www.lobre.lat A    <VPS_IP>
```
TTL 300 detik cukup. Caddy akan request sertifikat Let's Encrypt otomatis setelah DNS propagasi (~5 menit).

---

## 15. Registrasi Discovery (x402scan / mppscan)

```bash
npx -y @agentcash/discovery@latest discover "https://lobre.lat"
npx -y @agentcash/discovery@latest check "https://lobre.lat"
```

Setelah lolos validasi tanpa error blocking, daftarkan origin ke:
- `https://www.x402scan.com/resources/register`
- `https://www.mppscan.com/register`

---

## 16. Landing Page & Public Docs — Copy Bersih

> **Prinsip utama**: landing page dan halaman docs publik **tidak boleh menyebut stack internal sama sekali** — tidak ada "Hono", "Bun", "Redis", "Qdrant", "VPS", "x402-hono", "mppx", "CCXT", "GeckoTerminal", dst. Yang publik lihat cuma: apa yang Lobre lakukan, berapa harganya, dan cara pakainya. Detail implementasi itu urusan §1-15 di dokumen ini, bukan konsumsi publik.

### 16.1 Referensi Gaya: stableenrich.dev

Struktur dan nada dari `stableenrich.dev` dipakai sebagai acuan karena sudah terbukti efektif untuk audiens ini (AI agent + developer yang mengintegrasikan agent):

- Hero pendek, langsung ke value proposition, bukan penjelasan teknis.
- Kotak onboarding CLI 3 langkah (`onboard` → `try` → `add`) — bukan tutorial API key/OAuth.
- Kartu harga dikelompokkan per **kategori kegunaan**, bukan daftar mentah 15 endpoint.
- Tabel perbandingan "cara lama vs cara agentic" untuk mendidik pengunjung yang belum familiar dengan x402/MPP.
- Footer menyebut protokol terbuka (x402, MPP) dan jaringan settlement (Base/Solana/Tempo) — ini boleh disebut karena itu standar terbuka publik, bukan implementasi internal Lobre.
- **Tidak ada** satu pun penyebutan framework, database, atau layanan cloud yang dipakai di baliknya.

### 16.2 Draft Copy Hero (`index.astro`)

```text
Tagline: "Infrastructure agents can keep reaching for."
Subhead: "Your agent explores. You pay pennies."

Body: Lobre unifies 15 utility endpoints across trading, coding,
and research behind one stateless interface. No sign-ups.
No credential overhead. Real-time settlement.

CLI Onboarding Box:
  Step 1: npx agentcash onboard
  Step 2: npx agentcash try https://lobre.lat
  Step 3: npx agentcash add https://lobre.lat
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

### **Phase 0 — Persiapan & Infrastruktur** *(sebelum menulis kode apa pun)*
- [ ] Sewa VPS Linux (Ubuntu 22.04 LTS, min. 1 vCPU / 2 GB RAM) — Hetzner/DigitalOcean/Vultr.
- [ ] Beli domain `lobre.lat` (Namecheap/Cloudflare Registrar), arahkan A record ke IP VPS.
- [ ] SSH ke VPS, install Bun + Docker + Caddy + PM2 sesuai langkah §14.1.
- [ ] Jalankan `docker compose up -d` (Redis + Qdrant) dari `infra/docker-compose.yml`.
- [ ] Generate wallet operator EVM (`EVM_PAYEE_ADDRESS`) dan fee-payer (opsional).
- [ ] Daftar CDP API Key di `portal.cdp.coinbase.com`, daftar Groq API key di `console.groq.com`.
- [ ] Generate `MPP_SECRET_KEY` via `openssl rand -hex 32`, simpan aman.
- [ ] Verifikasi alamat kontrak Tempo USDC terbaru di `mpp.dev/docs`.
- [ ] Buat file `.env` di VPS (`/opt/lobre/.env`) sesuai §13 — jangan commit ke repo.

### **Phase 1 — Skeleton Proyek**
- [ ] Scaffold monorepo sesuai struktur folder di §5.
- [ ] `bun init` + install dependency inti: `hono`, `@x402/hono`, `mppx`, `@hono/mcp`, `@modelcontextprotocol/sdk`, `ioredis`.
- [ ] **Buat `src/backend/types.ts` terlebih dahulu** (lihat §6.2) — prerequisite semua file backend lain.
- [ ] Setup `infra/Caddyfile`, `infra/docker-compose.yml`, `infra/ecosystem.config.cjs` sesuai §14.
- [ ] Deploy "Hello World" Hono via `bun run src/backend/server.ts` + PM2 ke VPS, verifikasi `https://lobre.lat` dapat diakses dengan HTTPS.

### **Phase 2 — Payment Layer (Testnet)**
- [ ] Implementasi `middleware/x402.ts` dengan facilitator `x402.org` (testnet).
- [ ] Implementasi `middleware/mpp.ts` dengan `mppx/hono`.
- [ ] Bangun **satu** endpoint contoh (`trading/vitals`) dengan payment gate ganda (x402 + MPP) — middleware di level app, bukan handler.
- [ ] Uji manual pakai `mppx` CLI dan `agentcash fetch` dari sisi klien untuk memastikan 402 challenge dan settlement jalan.

### **Phase 3 — Bundle 1: Trading Engine**
- [ ] Implementasi `vitals` & `orderbook-depth` dengan sumber hybrid CEX (CCXT) + DEX (GeckoTerminal).
- [ ] Implementasi `funding-rates` dari CCXT exchange derivatif (Binance Futures/Bybit/OKX) — **jangan** pakai sumber DEX.
- [ ] Implementasi `whale-tracker` & `mev-risk-index` dari Basescan/Blockscout.
- [ ] Bangun `lib/cache.ts` (Redis via ioredis) dan pasang di setiap endpoint.
- [ ] Tuning TTL Redis per endpoint berdasarkan volatilitas data.

### **Phase 4 — Bundle 2: Coding Cache**
- [ ] Implementasi parser AST (`@babel/parser`/`es-module-lexer`) untuk `dependency-tree` dan `syntax-heartbeat`.
- [ ] Implementasi regex compressor untuk `token-compressor`.
- [ ] Implementasi `refactor-suggest` dan `security-audit` (Groq API atau database pattern statis).

### **Phase 5 — Bundle 3: Analysis / Vector Pruner**
- [ ] Setup `@xenova/transformers`, implementasi `heartbeat` (embedding CPU lokal + cosine similarity).
- [ ] Implementasi `entity-extractor` dan `bias-detector` via Groq API (`llama-3.3-70b-versatile`, JSON output).
- [ ] Setup Qdrant collection, implementasi `context-ranker` (bge embedding + Qdrant search).
- [ ] Implementasi `fact-linkage` (Google Fact Check Tools API + Groq fallback).

### **Phase 6 — Discovery & Bazaar**
- [ ] Bangun route `/openapi.json` lengkap 15 endpoint dengan `x-payment-info` valid.
- [ ] Tulis `public/llms.txt` final.
- [ ] Cek `@x402/extensions/bazaar` di npm — kalau sudah tersedia, pasang; kalau belum, lewati (lihat §10).
- [ ] Jalankan `@agentcash/discovery discover` dan `check`, perbaiki semua warning.

### **Phase 7 — MCP Server**
- [ ] Implementasi `routes/mcp.ts` dengan `@hono/mcp` (per-request instantiation pattern — lihat §8).
- [ ] Register 15 tools ke MCP server, mapping ke helper yang sama dengan REST routes.
- [ ] Uji koneksi MCP pakai MCP Inspector atau client Claude Desktop.

### **Phase 8 — Frontend: Landing Page & Docs**
- [ ] Scaffold Astro + Tailwind v4 sesuai design system §11.
- [ ] Bangun `index.astro` mengikuti copy bersih §16.2-16.4.
- [ ] Bangun `docs.astro` sesuai batasan §16.5 (fungsional + contoh JSON, tanpa detail implementasi).
- [ ] `bun run build` di folder frontend, output static ke `dist/` — Caddy serve langsung dari `dist/`.
- [ ] Update `infra/Caddyfile` untuk serve static Astro di root dan proxy `/api/*` ke Bun backend.

### **Phase 9 — Go Production**
- [ ] Ganti facilitator x402 dari `x402.org` ke CDP Facilitator produksi di `middleware/x402.ts`.
- [ ] Update `.env` di VPS dengan semua production credentials (CDP key, real EVM payee address).
- [ ] Setup GitHub Actions SSH deploy (§14.5) — push ke `main` otomatis reload PM2 di VPS.
- [ ] Smoke test end-to-end dengan jumlah USDC kecil.

### **Phase 10 — Registrasi & Go-Live**
- [ ] Daftarkan origin ke x402scan dan mppscan (lihat §15).
- [ ] Verifikasi listing muncul di CDP Bazaar (dengan fallback manual jika belum, lihat §10).
- [ ] Monitoring awal: cek margin riil vs proyeksi harga di §4, sesuaikan bila perlu.
- [ ] Umumkan Lobre ke komunitas `awesome-x402` / `awesome-mpp`.

---

*Dokumen ini adalah living document — update setiap kali ada perubahan kebijakan facilitator, alamat kontrak, atau skema discovery dari pihak Coinbase/Tempo/AgentCash.*
