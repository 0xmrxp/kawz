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

// Bun picks up the exported { port, fetch } object and starts the HTTP server.
export default { port, fetch: app.fetch };
