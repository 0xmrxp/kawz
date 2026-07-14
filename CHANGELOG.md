# Changelog

All notable changes to Lobre are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]
- Phase 9 remaining: CDP Facilitator production key, GitHub Actions SSH deploy, smoke test
- Phase 10: Discovery registration (x402scan, mppscan)

---

## [0.9.1-dev] — 2026-07-14 · Bazaar Discovery + CDP Auth Investigation

### Added
- `@x402/extensions ^2.18.0` to package.json
- `middleware/x402.ts`: per-route Bazaar discovery via `declareDiscoveryExtension()` — all 15 endpoints have input/output schemas and examples for CDP Bazaar catalog
- `ROUTE_DESCRIPTIONS` map: human-readable descriptions per endpoint in 402 response

### Fixed
- `middleware/x402.ts`: pass `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` to `HTTPFacilitatorClient` (was missing — caused 401 from CDP)
- `middleware/x402.ts`: remove `bazaarResourceServerExtension` from `.register()` call (wrong API — `.register()` only accepts `(network, scheme)`)

### Known Issue
- CDP facilitator (`api.cdp.coinbase.com/platform/v2/x402`) returns 401 with current API key — CDP auth uses Ed25519 JWT format, not simple key header. Server falls back to testnet facilitator (`x402.org`) when `CDP_API_KEY_ID` is empty. Under investigation at `discord.gg/cdp`.

---

## [0.9.0-dev] — 2026-07-14 · VPS Deployment + Bug Fixes

### Deployed
- Lobre live at `https://lobre.lat` — Ubuntu 22.04 VPS, DigitalOcean
- Caddy auto-HTTPS (Let's Encrypt), PM2 fork mode, Docker Redis + Qdrant, Ollama qwen2.5:3b

### Fixed
- `src/backend/middleware/x402.ts` — rewrote using correct `@x402/hono` v2 API:
  `paymentMiddleware(routes, x402ResourceServer)` + `ExactEvmScheme` from `@x402/evm/exact/server`
  (fixes: `No scheme implementation registered for exact on eip155:84532`)
- `infra/ecosystem.config.cjs` — added `exec_mode: 'fork'`
  (fixes: PM2 cluster mode incompatible with Bun, process online but port never binds)
- `src/backend/server.ts` — replaced `export default { port, fetch }` with `Bun.serve()`
  (fixes: Bun HTTP server not activating under PM2 fork)
- `src/backend/types.ts` — removed `GROQ_API_KEY` from production required list
  (Groq is now optional fallback — was crashing server on startup with empty key)

### Added
- `@x402/evm@2.18.0` to `package.json` (required for `ExactEvmScheme`)

---

## [0.8.1] — 2026-07-14 · LLM Abstraction — Ollama primary + Groq fallback

### Added
- `src/backend/lib/llm.ts` — unified LLM client: Ollama (`qwen2.5:3b` GGUF Q4_K_M) primary via OpenAI-compatible fetch, Groq cloud (`llama-3.3-70b-versatile`) fallback when Ollama unavailable

### Changed
- `src/backend/lib/groq.ts` → **deleted** (replaced by `lib/llm.ts`)
- `src/backend/routes/coding.ts` — `/refactor-suggest` + `/security-audit` updated to `llmChat(getLLMConfig(env), ...)`; removed `GROQ_API_KEY` required check
- `src/backend/routes/analysis.ts` — `/entity-extractor`, `/bias-detector`, `/fact-linkage` updated to `llmChat`; `source` field in fact-linkage LLM response renamed `"groq_llm"` → `"llm"`
- `src/backend/routes/mcp.ts` — all 5 LLM tools updated to `llmChat`; removed Groq SDK import and `groq` singleton; replaced with `llm = getLLMConfig(env)`
- `src/backend/types.ts` — added `LLM_BASE_URL: string` + `LLM_MODEL: string` to `Env` interface and `loadEnv()` (defaults: `http://localhost:11434`, `qwen2.5:3b`)
- `.env.example` — added `LLM_BASE_URL`, `LLM_MODEL`; `GROQ_API_KEY` marked as optional cloud backup

---

## [0.8.0] — 2026-07-14 · Phase 8 — Astro Frontend
**Commit:** `25691f5`

### Added
- `src/frontend/` — Astro v4 + Tailwind CSS v4 project
- `src/frontend/src/pages/index.astro` — Landing page: hero, CLI onboarding box, 3 bundle pricing cards, old-vs-agentic comparison table, footer
- `src/frontend/src/pages/docs.astro` — Full API reference: all 15 endpoints with method, path, price, summary, request/response examples
- `src/frontend/src/layouts/MainLayout.astro` — HTML shell with Google Fonts (Space Grotesk, JetBrains Mono)
- `src/frontend/src/components/Header.astro` — Nav with logo and links
- `src/frontend/src/components/TerminalBox.astro` — CLI step display component
- `src/frontend/src/components/PricingRow.astro` — Bundle card with optional gold accent
- `src/frontend/src/styles/global.css` — Tailwind v4 `@theme` with palette and font variables
- Design system: Neo-Brutalism × Functional Bauhaus — `#1E2229` / `#282D37` / `#D4AF37`, `rounded-none`, hard 4px box-shadow

---

## [0.7.0] — 2026-07-14 · Phases 4, 5, 7 — Coding Cache + Analysis + MCP
**Commit:** `8ccae3c`

### Added
- `src/backend/lib/ast-parser.ts` — `buildDependencyTree()` via `@babel/parser`, `checkSyntax()`, `compressTokens()`
- `src/backend/routes/coding.ts` — 5 real endpoints:
  - `/dependency-tree` — @babel/parser AST import/export graph
  - `/token-compressor` — regex comment + whitespace strip
  - `/syntax-heartbeat` — parse error collection
  - `/refactor-suggest` — Groq `llama-3.3-70b-versatile` JSON output
  - `/security-audit` — Groq LLM vulnerability detection
- `src/backend/routes/analysis.ts` — 5 real endpoints:
  - `/heartbeat` — `@xenova/transformers` BGE-base cosine similarity
  - `/entity-extractor` — Groq structured NER
  - `/context-ranker` — embed query + chunks, rank by cosine similarity
  - `/bias-detector` — Groq structured bias detection
  - `/fact-linkage` — Google Fact Check Tools API + Groq fallback
- `src/backend/routes/mcp.ts` — MCP server with 15 tools registered via `buildMcpServer(env)`, zod input schemas
- `src/backend/types.ts` — Added `GOOGLE_FACTCHECK_API_KEY` (optional)
- `.env.example` — Added `GOOGLE_FACTCHECK_API_KEY`

---

## [0.6.0] — 2026-07-14 · Phase 3 — Trading Engine
**Commit:** `54aebf8`

### Added
- `src/backend/routes/trading.ts` — 5 real endpoints:
  - `/vitals` — CCXT Binance `fetchTicker` BTC/ETH + CoinGecko fallback
  - `/orderbook-depth` — CCXT `fetchOrderBook`, spread + imbalance, `?pair=` param
  - `/funding-rates` — CCXT `fetchFundingRate` BTC/ETH/SOL perpetual futures
  - `/whale-tracker` — Blockscout Base API USDC transfers > $500K (Basescan V1 deprecated Aug 2025)
  - `/mev-risk-index` — Base public RPC latest block analysis, risk score 0–100
- CCXT Binance singleton pattern (reused across requests)
- `src/backend/types.ts` — Added `BLOCKSCOUT_BASE_URL`, `BASE_RPC_URL` (public defaults)
- `.env.example` — Added on-chain data sources + `FORCE_PAYMENT` flag

### Changed
- `package.json` — Fixed `typecheck` script to `node node_modules/typescript/bin/tsc --noEmit`

---

## [0.5.0] — 2026-07-14 · Phase 2 — Payment Layer (Testnet)
**Commit:** `12cbc15`

### Added
- `src/backend/middleware/x402.ts` — Real `paymentMiddlewareFromConfig` from `@x402/hono`
  - `HTTPFacilitatorClient` from `@x402/core/server`
  - Testnet: `x402.org/facilitator` + `eip155:84532` (Base Sepolia)
  - Production: CDP Facilitator + `eip155:8453` (Base mainnet)
  - `FORCE_PAYMENT=true` env var for dev testing
- `src/backend/middleware/mpp.ts` — Real `Mppx.create()` from `mppx/hono` + `tempo()` from `mppx/server`
  - App-level wrapper: lookup `atomicUsdc` from `ROUTE_PRICE_MAP` per request path
- `src/backend/server.ts` — Simplified middleware calls to `createX402Middleware(env)` + `createMppMiddleware(env)`

---

## [0.4.0] — 2026-07-14 · Phase 1 — Backend Skeleton
**Commit:** `fefd150`

### Added
- `src/backend/types.ts` — `Env` interface + `Variables` type + `loadEnv()`
- `src/backend/config/pricing.ts` — `PRICING` map (15 endpoints × `{usdAmount, atomicUsdc}`) + `ROUTE_PRICE_MAP`
- `src/backend/middleware/x402.ts` — Dev pass-through stub
- `src/backend/middleware/mpp.ts` — Dev pass-through stub
- `src/backend/lib/cache.ts` — Redis cache-aside via `ioredis` (lazy singleton, graceful fallback)
- `src/backend/lib/ast-parser.ts` — Stubs + working `compressTokens()`
- `src/backend/lib/embeddings.ts` — `embed()` + `cosineSimilarity()` structure
- `src/backend/routes/trading.ts` — 5 stub endpoints
- `src/backend/routes/coding.ts` — 5 stub endpoints
- `src/backend/routes/analysis.ts` — 5 stub endpoints
- `src/backend/routes/openapi.ts` — Full `/api/openapi.json` all 15 endpoints with `x-payment-info`
- `src/backend/routes/mcp.ts` — Per-request McpServer pattern (stateless VPS)
- `src/backend/server.ts` — Hono + `Bun.serve()` + env injection + CORS + `/api/health`
- `.github/workflows/deploy.yml` — GitHub Actions SSH deploy via `appleboy/ssh-action`
- `public/llms.txt` — AI discovery manifest
- `bun.lock` — Lockfile (228 packages)

---

## [0.3.0] — 2026-07-14 · Phase 0 — Infrastructure Setup
**Commit:** `0fff14a`

### Added
- `.gitignore` — node_modules, dist, .env, HuggingFace model cache
- `.env.example` — All env var templates with Tempo USDC address pre-filled (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- `package.json` — All dependencies with validated versions (hono@4.12.30, @x402/hono@2.18.0, mppx@0.8.7, etc.)
- `tsconfig.json` — ESNext, bundler resolution, bun-types
- `bunfig.toml` — Bun runtime config
- `infra/docker-compose.yml` — Redis 7-alpine + Qdrant, localhost-only port binding
- `infra/Caddyfile` — Reverse proxy + auto HTTPS Let's Encrypt + www redirect
- `infra/ecosystem.config.cjs` — PM2 config with Bun interpreter
- `LOBRE_BLUEPRINT.md` — Updated Groq model `llama-3.1` → `llama-3.3-70b-versatile`

---

## [0.2.0] — 2026-07-14 · Blueprint v3 — VPS Migration
**Commit:** `21edb5b`

### Changed
- Renamed `KAWZ_BLUEPRINT.md` → `LOBRE_BLUEPRINT.md`
- Project renamed KAWZ → **Lobre**, domain `kawz.dev` → **lobre.lat**
- Full VPS migration:
  - Cloudflare Workers → VPS Linux (Bun + PM2)
  - Cloudflare KV → Redis (self-hosted)
  - Workers AI → Groq API + `@xenova/transformers`
  - Cloudflare Vectorize → Qdrant (self-hosted)
  - Cloudflare auto TLS → Caddy
  - `wrangler deploy` → GitHub Actions SSH deploy
- All 17 blueprint sections updated for VPS architecture

---

## [0.1.0] — 2026-07-14 · Blueprint v2 — Technical Corrections
**Commit:** `d7cd0f7`

### Fixed
- `@x402/hono` import path and middleware pattern (was `@x402/hono` SDK buyer → `paymentMiddleware` seller-side)
- CCXT import path (`ccxt/js/src/binance.js` internal path → named import `{ binance } from 'ccxt'`)
- `@x402/extensions/bazaar` marked as unverified (not found on npm registry)
- `trading.ts` anti-pattern: middleware now at app level, not per-handler
- MCP server: per-request instantiation (stateless pattern for VPS)
- Added missing `src/backend/types.ts` to folder structure
- `mpp.ts` import path clarified (`mppx/server` vs `mppx/hono`)
- Groq model `llama-3.1-70b-versatile` → `llama-3.3-70b-versatile` (3.1 deprecated)
- Tempo USDC Base contract confirmed: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Phase 1 roadmap updated: `types.ts` created first as prerequisite

---

## [0.0.1] — 2026-07-14 · Initial Blueprint
**Commit:** `5ecd101`

### Added
- `KAWZ_BLUEPRINT.md` — Canonical Architecture Blueprint v2
- `LICENSE` — Apache 2.0
