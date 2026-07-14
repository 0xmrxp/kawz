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

// Populate 402 response body + inject resource.inputSchema for mppscan compatibility.
// @x402/hono v2 puts the challenge in payment-required header; body stays {}.
app.use("/v1/*", async (c, next) => {
  await next();
  if (c.res.status === 402) {
    const challenged = c.res.headers.get("payment-required");
    if (challenged) {
      try {
        const decoded = JSON.parse(atob(challenged));
        const inputSchema = ROUTE_INPUT_SCHEMAS[c.req.path];
        if (inputSchema && decoded.resource) {
          decoded.resource.inputSchema = inputSchema;
        }
        const headers = new Headers(c.res.headers);
        headers.set("content-type", "application/json");
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
