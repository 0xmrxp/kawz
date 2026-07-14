import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadEnv, type Variables } from "./types";
import { createX402Middleware } from "./middleware/x402";
import { createMppMiddleware } from "./middleware/mpp";
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
  exposeHeaders: ["X-Payment-Response", "WWW-Authenticate"],
}));

// Health — no payment required
app.get("/health", (c) =>
  c.json({ status: "ok", version: "1.0.0", env: env.ENVIRONMENT, timestamp: Date.now() })
);

// Input schemas per route — added to resource.inputSchema in 402 challenge.
// mppscan requires this field to register endpoints without "Input schema is missing" warning.
const ROUTE_INPUT_SCHEMAS: Record<string, unknown> = {
  "/api/v1/trading/engine/vitals":              { type: "object", properties: {} },
  "/api/v1/trading/engine/orderbook-depth":     { type: "object", properties: { pair: { type: "string", description: "Trading pair (default: BTC/USDT)", example: "ETH/USDT" } } },
  "/api/v1/trading/engine/mev-risk-index":      { type: "object", properties: {} },
  "/api/v1/trading/engine/funding-rates":       { type: "object", properties: {} },
  "/api/v1/trading/engine/whale-tracker":       { type: "object", properties: {} },
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
};

// Bazaar accept schemas — injected into accepts[i].extensions.bazaar in 402 challenge.
// @x402/hono strips custom fields from Accept items, so we post-process here.
// Per x402scan DISCOVERY.md: input schema must be at accepts[].extensions.bazaar.{info,schema}.
// Per x402scan DISCOVERY.md: inputSchema must be at accepts[i].extensions.bazaar.info.input.inputSchema
// Format: info.input = { type, method, body|queryParams, inputSchema } + top-level schema (for @x402/hono validation)
const BAZAAR_ACCEPT_SCHEMAS: Record<string, { info: unknown; schema: unknown }> = {
  "/api/v1/trading/engine/vitals":            { info: { input: { type: "http", method: "GET",  queryParams: {},                                                        inputSchema: { type: "object", properties: {} } } },                                                                                                                          schema: { type: "object", properties: {} } },
  "/api/v1/trading/engine/orderbook-depth":   { info: { input: { type: "http", method: "GET",  queryParams: { pair: "BTC/USDT" },                                      inputSchema: { type: "object", properties: { pair: { type: "string", description: "Trading pair (default: BTC/USDT)" } } } } },                                         schema: { type: "object", properties: { pair: { type: "string" } } } },
  "/api/v1/trading/engine/mev-risk-index":    { info: { input: { type: "http", method: "GET",  queryParams: {},                                                        inputSchema: { type: "object", properties: {} } } },                                                                                                                          schema: { type: "object", properties: {} } },
  "/api/v1/trading/engine/funding-rates":     { info: { input: { type: "http", method: "GET",  queryParams: {},                                                        inputSchema: { type: "object", properties: {} } } },                                                                                                                          schema: { type: "object", properties: {} } },
  "/api/v1/trading/engine/whale-tracker":     { info: { input: { type: "http", method: "GET",  queryParams: {},                                                        inputSchema: { type: "object", properties: {} } } },                                                                                                                          schema: { type: "object", properties: {} } },
  "/api/v1/coding/cache/dependency-tree":     { info: { input: { type: "http", method: "POST", body: { code: "import { Hono } from 'hono';" },                         inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, filename: { type: "string" } } } } },                                        schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, filename: { type: "string" } } } },
  "/api/v1/coding/cache/token-compressor":    { info: { input: { type: "http", method: "POST", body: { raw_code: "const x = 1; // comment" },                         inputSchema: { type: "object", required: ["raw_code"], properties: { raw_code: { type: "string" } } } } },                                                            schema: { type: "object", required: ["raw_code"], properties: { raw_code: { type: "string" } } } },
  "/api/v1/coding/cache/syntax-heartbeat":    { info: { input: { type: "http", method: "POST", body: { code: "const x = 1;" },                                        inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } } },                                                                     schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } },
  "/api/v1/coding/cache/refactor-suggest":    { info: { input: { type: "http", method: "POST", body: { code: "function add(a,b){return a+b}", language: "javascript" }, inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } } } },                                           schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } } },
  "/api/v1/coding/cache/security-audit":      { info: { input: { type: "http", method: "POST", body: { code: "db.query(`SELECT * FROM users WHERE id=${req.id}`)", language: "javascript" }, inputSchema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } } } },                   schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } } },
  "/api/v1/analysis/memory/heartbeat":        { info: { input: { type: "http", method: "POST", body: { text_a: "machine learning", text_b: "deep learning" },          inputSchema: { type: "object", required: ["text_a", "text_b"], properties: { text_a: { type: "string" }, text_b: { type: "string" } } } } },                           schema: { type: "object", required: ["text_a", "text_b"], properties: { text_a: { type: "string" }, text_b: { type: "string" } } } },
  "/api/v1/analysis/memory/entity-extractor": { info: { input: { type: "http", method: "POST", body: { text: "Satoshi Nakamoto published Bitcoin in 2008." },          inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } },                                                                     schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  "/api/v1/analysis/memory/context-ranker":   { info: { input: { type: "http", method: "POST", body: { query: "machine learning", chunks: ["deep learning", "spreadsheets"] }, inputSchema: { type: "object", required: ["query", "chunks"], properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } } } } }, schema: { type: "object", required: ["query", "chunks"], properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } } } },
  "/api/v1/analysis/memory/bias-detector":    { info: { input: { type: "http", method: "POST", body: { text: "The radical policy will destroy the economy." },          inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } },                                                                     schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  "/api/v1/analysis/memory/fact-linkage":     { info: { input: { type: "http", method: "POST", body: { claim: "The moon landing was faked.", language: "en" },          inputSchema: { type: "object", required: ["claim"], properties: { claim: { type: "string" }, language: { type: "string" } } } } },                                       schema: { type: "object", required: ["claim"], properties: { claim: { type: "string" }, language: { type: "string" } } } },
};

// Populate 402 response body, inject resource.inputSchema + accepts[].extensions.bazaar.
// @x402/hono v2 puts the challenge in payment-required header; body stays {}.
// paymentMiddleware strips custom fields from accepts[] items, so we post-process here.
app.use("/v1/*", async (c, next) => {
  await next();
  if (c.res.status === 402) {
    const challenged = c.res.headers.get("payment-required");
    if (challenged) {
      try {
        const decoded = JSON.parse(atob(challenged));
        const path = c.req.path;

        // resource.inputSchema
        const inputSchema = ROUTE_INPUT_SCHEMAS[path];
        if (inputSchema && decoded.resource) {
          decoded.resource.inputSchema = inputSchema;
        }

        // accepts[i].extensions.bazaar — x402scan/mppscan DISCOVERY.md spec
        const bazaarAcceptSchema = BAZAAR_ACCEPT_SCHEMAS[path];
        if (bazaarAcceptSchema && Array.isArray(decoded.accepts)) {
          decoded.accepts = decoded.accepts.map((accept: unknown) => ({
            ...(accept as Record<string, unknown>),
            extensions: { bazaar: bazaarAcceptSchema },
          }));
        }

        const headers = new Headers(c.res.headers);
        headers.set("content-type", "application/json");
        headers.set("payment-required", btoa(JSON.stringify(decoded)));
        c.res = new Response(JSON.stringify(decoded), { status: 402, headers });
      } catch { /* leave {} body if decode fails */ }
    }
  }
});

// Payment middleware — applied to all /v1/* routes
// Dev mode: pass-through unless FORCE_PAYMENT=true. Production: real x402 + MPP.
app.use("/v1/*", createX402Middleware(env));
app.use("/v1/*", createMppMiddleware(env));

// Route bundles
app.route("/v1/trading/engine", trading);
app.route("/v1/coding/cache", coding);
app.route("/v1/analysis/memory", analysis);
app.route("/", openapi);  // GET /api/openapi.json
app.route("/mcp", mcp);   // ALL /api/mcp

const port = parseInt(env.PORT);

console.log(`[lobre] listening on http://localhost:${port} (${env.ENVIRONMENT})`);

// Rewrite http:// → https:// when Caddy signals the public request was HTTPS.
// Required so @x402/hono builds the correct resource URL in the payment challenge
// (Caddy terminates TLS and forwards internally via HTTP, so req.url is http://).
function proxyFetch(req: Request): Response | Promise<Response> {
  if (req.headers.get("x-forwarded-proto") === "https" && req.url.startsWith("http://")) {
    req = new Request(req.url.replace(/^http:\/\//, "https://"), req);
  }
  return app.fetch(req);
}

Bun.serve({ port, fetch: proxyFetch });
