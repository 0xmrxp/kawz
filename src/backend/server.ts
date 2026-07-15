import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadEnv, type Variables } from "./types";
import { createX402Middleware } from "./middleware/x402";
import { createMppMiddleware } from "./middleware/mpp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import trading from "./routes/trading";
import coding from "./routes/coding";
import analysis from "./routes/analysis";
import openapi from "./routes/openapi";
import mcp from "./routes/mcp";

const env = loadEnv();

const app = new Hono<{ Variables: Variables }>().basePath("/api");

// Inject env into every request context
app.use("*", (c, next) => { c.set("env", env); return next(); });

// CORS — permissive: auth is the payment proof, not the request origin
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Payment", "X-Payment-Response", "Payment-Signature"],
  exposeHeaders: ["X-Payment-Response", "WWW-Authenticate", "payment-required"],
}));

// Health — no payment required
app.get("/health", (c) =>
  c.json({ status: "ok", version: "1.0.0", env: env.ENVIRONMENT, timestamp: Date.now() })
);

// Input schemas per route — added to resource.inputSchema in 402 challenge.
// mppscan requires this field to register endpoints without "Input schema is missing" warning.
const ROUTE_INPUT_SCHEMAS: Record<string, unknown> = {
  "/api/v1/trading/engine/vitals":              { type: "object", properties: { symbols: { type: "string", default: "btc,eth", description: "btc, eth or btc,eth" } } },
  "/api/v1/trading/engine/orderbook-depth":     { type: "object", properties: { pair: { type: "string", description: "Trading pair (default: BTC/USDT)", example: "ETH/USDT" } } },
  "/api/v1/trading/engine/mev-risk-index":      { type: "object", properties: {} },
  "/api/v1/trading/engine/funding-rates":       { type: "object", properties: { symbols: { type: "string", description: "Comma-separated: BTC,ETH,SOL. Omit for all." } } },
  "/api/v1/trading/engine/whale-tracker":       { type: "object", properties: { threshold: { type: "number", minimum: 10000, default: 500000, description: "Min USDC transfer USD" } } },
  "/api/v1/coding/cache/dependency-tree":       { type: "object", required: ["code"], properties: { code: { type: "string" }, filename: { type: "string" } } },
  "/api/v1/coding/cache/token-compressor":      { type: "object", required: ["raw_code"], properties: { raw_code: { type: "string" } } },
  "/api/v1/coding/cache/syntax-heartbeat":      { type: "object", required: ["code"], properties: { code: { type: "string" } } },
  "/api/v1/coding/cache/refactor-suggest":      { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string", default: "typescript" } } },
  "/api/v1/coding/cache/security-audit":        { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string", default: "typescript" } } },
  "/api/v1/analysis/memory/heartbeat":          { type: "object", required: ["text_a", "text_b"], properties: { text_a: { type: "string" }, text_b: { type: "string" } } },
  "/api/v1/analysis/memory/entity-extractor":   { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  "/api/v1/analysis/memory/context-ranker":     { type: "object", required: ["query", "chunks"], properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } } },
  "/api/v1/analysis/memory/bias-detector":      { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  "/api/v1/analysis/memory/fact-linkage":       { type: "object", required: ["claim"], properties: { claim: { type: "string" }, language: { type: "string", default: "en" } } },
  "/api/mcp":                                   { type: "object", required: ["jsonrpc", "method"], properties: { jsonrpc: { type: "string", const: "2.0" }, method: { type: "string" }, params: { type: "object" }, id: { type: "number" } } },
};

// Bazaar accept schemas — injected into extensions.bazaar in 402 challenge by the
// post-processing interceptor below. Uses the official declareDiscoveryExtension() from
// @x402/extensions/bazaar, matching exactly what x402.ts puts in the route config.
// Extracting .bazaar gives the { info, schema } inner object the interceptor expects.
const BAZAAR_ACCEPT_SCHEMAS: Record<string, unknown> = {
  "/api/v1/trading/engine/vitals":            declareDiscoveryExtension({ input: { symbols: "btc,eth" }, inputSchema: { properties: { symbols: { type: "string", description: "Comma-separated: btc, eth, or btc,eth. Default: btc,eth" } } }, output: { example: { btc: { price: 65432, change24h: 2.3, volume24h: 28500000000 }, eth: { price: 3210, change24h: 1.1, volume24h: 14200000000 } } } }).bazaar,
  "/api/v1/trading/engine/orderbook-depth":   declareDiscoveryExtension({ input: { pair: "BTC/USDT" }, inputSchema: { properties: { pair: { type: "string", description: "Trading pair e.g. BTC/USDT, ETH/USDT. Default: BTC/USDT" } } }, output: { example: { bids: [[65400, 1.2]], asks: [[65420, 0.8]], spread: 20, imbalance: 0.35 } } }).bazaar,
  "/api/v1/trading/engine/mev-risk-index":    declareDiscoveryExtension({ output: { example: { risk_score: 42, block: 128503241, timestamp: 1752000000000 } } }).bazaar,
  "/api/v1/trading/engine/funding-rates":     declareDiscoveryExtension({ input: { symbols: "BTC,ETH,SOL" }, inputSchema: { properties: { symbols: { type: "string", description: "Comma-separated: BTC,ETH,SOL. Omit for all." } } }, output: { example: { BTC: { rate: 0.0001, interval_hours: 8 }, ETH: { rate: 0.00005, interval_hours: 8 } } } }).bazaar,
  "/api/v1/trading/engine/whale-tracker":     declareDiscoveryExtension({ input: { threshold: 500000 }, inputSchema: { properties: { threshold: { type: "number", description: "Min USDC transfer USD. Default: 500000" } } }, output: { example: { transfers: [{ from: "0xabc", to: "0xdef", amount: 1500000, tx: "0x123", block: 128503000 }] } } }).bazaar,
  "/api/v1/coding/cache/dependency-tree":     declareDiscoveryExtension({ bodyType: "json", input: { code: "import { Hono } from 'hono';", filename: "server.ts" }, inputSchema: { properties: { code: { type: "string" }, filename: { type: "string" } }, required: ["code"] }, output: { example: { nodes: ["server.ts", "hono"], edges: [{ from: "server.ts", to: "hono", type: "import" }] } } }).bazaar,
  "/api/v1/coding/cache/token-compressor":    declareDiscoveryExtension({ bodyType: "json", input: { raw_code: "const x = 1; // comment" }, inputSchema: { properties: { raw_code: { type: "string", description: "Source code to compress for LLM token efficiency" } }, required: ["raw_code"] }, output: { example: { compressed: "const x=1;", original_tokens: 12, compressed_tokens: 7, ratio: 0.58 } } }).bazaar,
  "/api/v1/coding/cache/syntax-heartbeat":    declareDiscoveryExtension({ bodyType: "json", input: { code: "const x = 1;" }, inputSchema: { properties: { code: { type: "string", description: "JS/TS/JSX source code to validate syntax" } }, required: ["code"] }, output: { example: { valid: true, errors: [] } } }).bazaar,
  "/api/v1/coding/cache/refactor-suggest":    declareDiscoveryExtension({ bodyType: "json", input: { code: "function add(a,b){return a+b}", language: "javascript" }, inputSchema: { properties: { code: { type: "string" }, language: { type: "string", description: "javascript or typescript. Default: typescript" } }, required: ["code"] }, output: { example: { suggestions: [{ severity: "low", description: "Add type annotations", line: 1 }] } } }).bazaar,
  "/api/v1/coding/cache/security-audit":      declareDiscoveryExtension({ bodyType: "json", input: { code: "db.query('SELECT * FROM users WHERE id='+req.id)", language: "javascript" }, inputSchema: { properties: { code: { type: "string" }, language: { type: "string", description: "javascript or typescript" } }, required: ["code"] }, output: { example: { issues: [{ type: "SQL_INJECTION", severity: "high", line: 1, description: "Unsanitized user input in query" }], risk_level: "HIGH" } } }).bazaar,
  "/api/v1/analysis/memory/heartbeat":        declareDiscoveryExtension({ bodyType: "json", input: { text_a: "machine learning", text_b: "deep learning" }, inputSchema: { properties: { text_a: { type: "string" }, text_b: { type: "string" } }, required: ["text_a","text_b"] }, output: { example: { similarity: 0.87 } } }).bazaar,
  "/api/v1/analysis/memory/entity-extractor": declareDiscoveryExtension({ bodyType: "json", input: { text: "Satoshi Nakamoto published Bitcoin in 2008." }, inputSchema: { properties: { text: { type: "string", description: "Text to extract named entities from" } }, required: ["text"] }, output: { example: { entities: [{ text: "Satoshi Nakamoto", type: "PERSON" }, { text: "Bitcoin", type: "ORG" }] } } }).bazaar,
  "/api/v1/analysis/memory/context-ranker":   declareDiscoveryExtension({ bodyType: "json", input: { query: "machine learning", chunks: ["deep learning intro", "spreadsheet tutorial"] }, inputSchema: { properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" }, description: "Text chunks to re-rank by relevance" } }, required: ["query","chunks"] }, output: { example: { ranked: [{ text: "deep learning intro", score: 0.91 }] } } }).bazaar,
  "/api/v1/analysis/memory/bias-detector":    declareDiscoveryExtension({ bodyType: "json", input: { text: "The radical policy will destroy the economy." }, inputSchema: { properties: { text: { type: "string", description: "Text to analyze for framing bias and loaded language" } }, required: ["text"] }, output: { example: { bias_score: 0.78, sentiment: "negative", loaded_words: ["radical", "destroy"] } } }).bazaar,
  "/api/v1/analysis/memory/fact-linkage":     declareDiscoveryExtension({ bodyType: "json", input: { claim: "The moon landing was faked.", language: "en" }, inputSchema: { properties: { claim: { type: "string" }, language: { type: "string", description: "ISO 639-1 language code. Default: en" } }, required: ["claim"] }, output: { example: { verdict: "false", confidence: 0.97, sources: [{ url: "https://nasa.gov/apollo", excerpt: "..." }] } } }).bazaar,
  "/api/mcp":                                 declareDiscoveryExtension({ bodyType: "json", input: { jsonrpc: "2.0", method: "tools/call", params: { name: "trading-vitals", arguments: {} }, id: 1 }, inputSchema: { properties: { jsonrpc: { type: "string", description: "JSON-RPC version, must be '2.0'" }, method: { type: "string", description: "MCP method e.g. tools/call, tools/list" }, params: { type: "object" }, id: { type: "number" } }, required: ["jsonrpc","method"] } }).bazaar,
};

// Populate 402 response body, inject resource.inputSchema + accepts[].extensions.bazaar.
// @x402/hono v2 puts the challenge in payment-required header; body stays {}.
// paymentMiddleware strips custom fields from accepts[] items, so we post-process here.
// Uses "*" so it also catches /mcp 402 responses in addition to /v1/*.
app.use("*", async (c, next) => {
  await next();
  if (c.res.status === 402) {
    const challenged = c.res.headers.get("payment-required");
    if (challenged) {
      try {
        const decoded = JSON.parse(atob(challenged));
        // c.req.path is basePath-relative (/v1/...) in Hono; maps use /api/v1/... keys
        const rawPath = c.req.path;
        const lookupPath = rawPath.startsWith("/v1/") ? `/api${rawPath}` : rawPath;

        // resource.inputSchema — injected at top-level and into each accepts[] item
        // for maximum scanner compatibility (mppscan checks both locations).
        // x402 v2 has no top-level resource field; decoded.resource starts undefined.
        // If somehow it's a URL string (older spec), preserve it under .url.
        const inputSchema = ROUTE_INPUT_SCHEMAS[lookupPath];
        if (inputSchema) {
          if (typeof decoded.resource === "string") {
            decoded.resource = { url: decoded.resource, inputSchema };
          } else {
            if (!decoded.resource) decoded.resource = {};
            decoded.resource.inputSchema = inputSchema;
          }
          // Also inject into each accepts[] item so mppscan finds it regardless of location
          if (Array.isArray(decoded.accepts)) {
            for (const accept of decoded.accepts) {
              if (accept && typeof accept === "object") {
                (accept as Record<string, unknown>).inputSchema = inputSchema;
              }
            }
          }
        }

        // extensions.bazaar — inject into both locations for maximum scanner compatibility:
        // - decoded.extensions.bazaar       (x402 v2 top-level spec location)
        // - decoded.accepts[0].extensions.bazaar  (some scanners check accepts-level)
        const bazaarSchema = BAZAAR_ACCEPT_SCHEMAS[lookupPath];
        if (bazaarSchema) {
          if (!decoded.extensions) decoded.extensions = {};
          // Merge — preserve category/tags/discoverable set by x402 middleware routes loop,
          // then overlay info+schema from BAZAAR_ACCEPT_SCHEMAS for scanner compatibility.
          const existingBazaar = decoded.extensions.bazaar;
          decoded.extensions.bazaar = {
            ...(existingBazaar && typeof existingBazaar === "object"
              ? (existingBazaar as Record<string, unknown>)
              : {}),
            ...bazaarSchema,
          };
          if (Array.isArray(decoded.accepts) && decoded.accepts.length > 0) {
            const accept = decoded.accepts[0] as Record<string, unknown>;
            if (!accept.extensions) accept.extensions = {};
            const existingAcceptBazaar = (accept.extensions as Record<string, unknown>).bazaar;
            (accept.extensions as Record<string, unknown>).bazaar = {
              ...(existingAcceptBazaar && typeof existingAcceptBazaar === "object"
                ? (existingAcceptBazaar as Record<string, unknown>)
                : {}),
              ...bazaarSchema,
            };
          }
        }

        const headers = new Headers(c.res.headers);
        const encoded = btoa(JSON.stringify(decoded));
        headers.set("content-type", "application/json");
        headers.set("payment-required", encoded);
        // Also set WWW-Authenticate for clients that expect x402 v1 challenge format
        headers.set("WWW-Authenticate", `x402 ${encoded}`);
        c.res = new Response(JSON.stringify(decoded), { status: 402, headers });
      } catch (err) {
        console.error("[402-interceptor] failed to enrich challenge:", err);
      }
    }
  }
});

// Payment middleware — @x402/hono handles EVM x402 (exact scheme, Base USDC),
// mppx handles Tempo. Dev mode: pass-through unless FORCE_PAYMENT=true.
app.use("/v1/*", createX402Middleware(env));
app.use("/v1/*", createMppMiddleware(env));
app.use("/mcp",  createX402Middleware(env));
app.use("/mcp",  createMppMiddleware(env));

// Route bundles
app.route("/v1/trading/engine", trading);
app.route("/v1/coding/cache", coding);
app.route("/v1/analysis/memory", analysis);
app.route("/", openapi);  // GET /api/openapi.json
app.route("/mcp", mcp);   // ALL /api/mcp

const port = parseInt(env.PORT);

console.log(`[lobre] listening on http://localhost:${port} (${env.ENVIRONMENT})`);

// x402 payment discovery — required by agents before they attempt payment.
// Lives outside the /api basePath so it's reachable at the standard well-known URL.
const WELL_KNOWN_X402 = JSON.stringify({
  version: 2,
  schemes: ["exact"],
  networks: ["eip155:8453"],
  facilitator: "https://api.cdp.coinbase.com/platform/v2/x402",
});

// Rewrite http:// → https:// when Caddy signals the public request was HTTPS.
// Required so @x402/hono builds the correct resource URL in the payment challenge
// (Caddy terminates TLS and forwards internally via HTTP, so req.url is http://).
function proxyFetch(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/.well-known/x402.json") {
    return new Response(WELL_KNOWN_X402, {
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    });
  }

  if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
    req = new Request(req.url.replace(/^http:\/\//, "https://"), req);
  }
  return app.fetch(req);
}

Bun.serve({ port, fetch: proxyFetch });
