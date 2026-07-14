// Serves GET /api/openapi.json — canonical machine-readable contract for agent discovery.
// This is the primary discovery file used by AgentCash, x402scan, and mppscan.

import { Hono } from "hono";
import { PRICING } from "../config/pricing";
import type { Variables } from "../types";

const openapi = new Hono<{ Variables: Variables }>();

openapi.get("/openapi.json", (c) => {
  const env = c.get("env");
  const base = env.BASE_URL;

  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Lobre Agentic Infrastructure Engine",
      version: "1.0.0",
      description: "Pay-per-request utility infrastructure for autonomous AI agents.",
      "x-guidance": [
        `Use GET ${base}/api/v1/trading/engine/vitals for live market vitals.`,
        `Use GET ${base}/api/v1/trading/engine/funding-rates for perpetual futures funding rates.`,
        `Use POST ${base}/api/v1/coding/cache/token-compressor with { raw_code: string } to compress source code.`,
        `Use POST ${base}/api/v1/analysis/memory/entity-extractor with { text: string } to extract entities.`,
        "All routes require x402 or MPP payment. Send payment proof in the X-Payment header.",
      ].join(" "),
      contact: { email: "team@lobre.lat" },
    },
    servers: [{ url: `${base}/api`, description: "Lobre production API" }],
    paths: {
      "/v1/trading/engine/vitals": {
        get: {
          operationId: "tradingVitals",
          summary: "Live market vitals — volatility, gas fees, market sentiment",
          tags: ["Trading"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["trading.vitals"].usdAmount },
            protocols: [
              { x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } },
              { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
            ],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/trading/engine/orderbook-depth": {
        get: {
          operationId: "tradingOrderbookDepth",
          summary: "Orderbook depth — CEX bids/asks + DEX liquidity comparison",
          tags: ["Trading"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["trading.orderbookDepth"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/trading/engine/mev-risk-index": {
        get: {
          operationId: "tradingMevRisk",
          summary: "MEV risk index — sandwich attack probability for current block",
          tags: ["Trading"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["trading.mevRiskIndex"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/trading/engine/funding-rates": {
        get: {
          operationId: "tradingFundingRates",
          summary: "Perpetual futures funding rates from CEX derivatives exchanges",
          tags: ["Trading"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["trading.fundingRates"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/trading/engine/whale-tracker": {
        get: {
          operationId: "tradingWhaleTracker",
          summary: "On-chain large transfer tracker — whale movements above threshold",
          tags: ["Trading"],
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["trading.whaleTracker"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/coding/cache/dependency-tree": {
        post: {
          operationId: "codingDependencyTree",
          summary: "Parse and return the import/export dependency graph of source code",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, filename: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["coding.dependencyTree"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/coding/cache/token-compressor": {
        post: {
          operationId: "codingTokenCompressor",
          summary: "Strip comments and whitespace from source code to minimize LLM token usage",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["raw_code"], properties: { raw_code: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["coding.tokenCompressor"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/coding/cache/syntax-heartbeat": {
        post: {
          operationId: "codingSyntaxHeartbeat",
          summary: "Validate syntax of a code snippet and return parse errors",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["coding.syntaxHeartbeat"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/coding/cache/refactor-suggest": {
        post: {
          operationId: "codingRefactorSuggest",
          summary: "LLM-powered refactor suggestions for a code snippet",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["coding.refactorSuggest"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/coding/cache/security-audit": {
        post: {
          operationId: "codingSecurityAudit",
          summary: "Static security audit — detect known-vulnerable patterns in source code",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["coding.securityAudit"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/analysis/memory/heartbeat": {
        post: {
          operationId: "analysisHeartbeat",
          summary: "Cosine similarity between two texts using BGE embeddings",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text_a", "text_b"], properties: { text_a: { type: "string" }, text_b: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["analysis.heartbeat"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/analysis/memory/entity-extractor": {
        post: {
          operationId: "analysisEntityExtractor",
          summary: "Extract named entities (people, orgs, dates, locations) from unstructured text",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["analysis.entityExtractor"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/analysis/memory/context-ranker": {
        post: {
          operationId: "analysisContextRanker",
          summary: "Re-rank a list of context chunks by semantic relevance to a query",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["query", "chunks"], properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["analysis.contextRanker"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/analysis/memory/bias-detector": {
        post: {
          operationId: "analysisBiasDetector",
          summary: "Detect framing bias, sentiment slant, and loaded language in text",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["analysis.biasDetector"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
      "/v1/analysis/memory/fact-linkage": {
        post: {
          operationId: "analysisFactLinkage",
          summary: "Link text claims to verified fact-check records (Google ClaimReview + LLM fallback)",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["claim"], properties: { claim: { type: "string" }, language: { type: "string", default: "en" } } } } } },
          "x-payment-info": {
            price: { mode: "fixed", currency: "USD", amount: PRICING["analysis.factLinkage"].usdAmount },
            protocols: [{ x402: { network: "eip155:8453", payTo: env.EVM_PAYEE_ADDRESS } }, { mpp: { method: "tempo", intent: "charge", currency: "USDC" } }],
          },
          responses: { "200": { description: "Success" }, "402": { description: "Payment Required" } },
        },
      },
    },
    tags: [
      { name: "Trading", description: "Non-Stop AI Trading Engine — CEX + DEX hybrid data" },
      { name: "Coding", description: "Coding Cache — AST analysis, compression, security audits" },
      { name: "Analysis", description: "Live Vector Pruner — embeddings, entities, fact verification" },
    ],
  });
});

export default openapi;
