import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadEnv, type Variables } from "./types";
import { createMppMiddleware } from "./middleware/mpp";
// @x402/hono removed — EVM x402 now handled by mppx evm.charge() in mpp.ts
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

// Bazaar accept schemas — injected into accepts[i].extensions.bazaar in 402 challenge.
// @x402/hono strips custom fields from Accept items, so we post-process here.
// Per x402scan DISCOVERY.md: input schema must be at accepts[].extensions.bazaar.{info,schema}.
// Mirrors BAZAAR_ACCEPT_SCHEMA in x402.ts.
// schema = JSON Schema describing the info structure (not example data).
// x402scan reads schema.properties.input.properties.body/queryParams for input schema.
const _SG    = { type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET","HEAD","DELETE"] } }, required: ["type","method"], additionalProperties: false } }, required: ["input"] };
const _SGQP  = (qp: unknown) => ({ type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET","HEAD","DELETE"] }, queryParams: { type: "object", properties: qp as Record<string,unknown> } }, required: ["type","method"], additionalProperties: false } }, required: ["input"] });
const _SP    = (body: unknown, req: string[]) => ({ type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["POST","PUT","PATCH"] }, bodyType: { type: "string", enum: ["json"] }, body: { type: "object", properties: body as Record<string,unknown>, required: req } }, required: ["type","method","bodyType","body"], additionalProperties: false } }, required: ["input"] });

const BAZAAR_ACCEPT_SCHEMAS: Record<string, { info: unknown; schema: unknown }> = {
  "/api/v1/trading/engine/vitals":            { info: { input: { type: "http", method: "GET", queryParams: { symbols: "btc,eth" } } },                                                       schema: _SGQP({ symbols: { type: "string", description: "btc, eth or btc,eth. Default: btc,eth" } }) },
  "/api/v1/trading/engine/orderbook-depth":   { info: { input: { type: "http", method: "GET", queryParams: { pair: "BTC/USDT" } } },                                                        schema: _SGQP({ pair: { type: "string", description: "Trading pair, default BTC/USDT" } }) },
  "/api/v1/trading/engine/mev-risk-index":    { info: { input: { type: "http", method: "GET" } },                                                                                            schema: _SG },
  "/api/v1/trading/engine/funding-rates":     { info: { input: { type: "http", method: "GET", queryParams: { symbols: "" } } },                                                              schema: _SGQP({ symbols: { type: "string", description: "Comma-separated: BTC,ETH,SOL. Omit for all." } }) },
  "/api/v1/trading/engine/whale-tracker":     { info: { input: { type: "http", method: "GET", queryParams: { threshold: 500000 } } },                                                        schema: _SGQP({ threshold: { type: "number", description: "Min USDC transfer USD. Default: 500000" } }) },
  "/api/v1/coding/cache/dependency-tree":     { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "import { Hono } from 'hono';", filename: "server.ts" } } }, schema: _SP({ code: { type: "string" }, filename: { type: "string" } }, ["code"]) },
  "/api/v1/coding/cache/token-compressor":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { raw_code: "const x = 1; // comment" } } },                         schema: _SP({ raw_code: { type: "string" } }, ["raw_code"]) },
  "/api/v1/coding/cache/syntax-heartbeat":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "const x = 1;" } } },                                        schema: _SP({ code: { type: "string" } }, ["code"]) },
  "/api/v1/coding/cache/refactor-suggest":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "function add(a,b){return a+b}", language: "javascript" } } }, schema: _SP({ code: { type: "string" }, language: { type: "string" } }, ["code"]) },
  "/api/v1/coding/cache/security-audit":      { info: { input: { type: "http", method: "POST", bodyType: "json", body: { code: "db.query('SELECT * FROM users WHERE id='+req.id)", language: "javascript" } } }, schema: _SP({ code: { type: "string" }, language: { type: "string" } }, ["code"]) },
  "/api/v1/analysis/memory/heartbeat":        { info: { input: { type: "http", method: "POST", bodyType: "json", body: { text_a: "machine learning", text_b: "deep learning" } } },         schema: _SP({ text_a: { type: "string" }, text_b: { type: "string" } }, ["text_a","text_b"]) },
  "/api/v1/analysis/memory/entity-extractor": { info: { input: { type: "http", method: "POST", bodyType: "json", body: { text: "Satoshi Nakamoto published Bitcoin in 2008." } } },          schema: _SP({ text: { type: "string" } }, ["text"]) },
  "/api/v1/analysis/memory/context-ranker":   { info: { input: { type: "http", method: "POST", bodyType: "json", body: { query: "machine learning", chunks: ["deep learning","spreadsheets"] } } }, schema: _SP({ query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } }, ["query","chunks"]) },
  "/api/v1/analysis/memory/bias-detector":    { info: { input: { type: "http", method: "POST", bodyType: "json", body: { text: "The radical policy will destroy the economy." } } },         schema: _SP({ text: { type: "string" } }, ["text"]) },
  "/api/v1/analysis/memory/fact-linkage":     { info: { input: { type: "http", method: "POST", bodyType: "json", body: { claim: "The moon landing was faked.", language: "en" } } },         schema: _SP({ claim: { type: "string" }, language: { type: "string" } }, ["claim"]) },
  "/api/mcp":                                { info: { input: { type: "http", method: "POST", bodyType: "json", body: { jsonrpc: "2.0", method: "tools/call", params: { name: "trading-vitals", arguments: {} }, id: 1 } } }, schema: _SP({ jsonrpc: { type: "string" }, method: { type: "string" }, params: { type: "object" }, id: { type: "number" } }, ["jsonrpc", "method"]) },
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

// Payment middleware — mppx handles both EVM x402 (Base USDC) and Tempo in one pass.
// Dev mode: pass-through unless FORCE_PAYMENT=true.
app.use("/v1/*", createMppMiddleware(env));
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
  facilitator: "https://x402.org/facilitator",
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
