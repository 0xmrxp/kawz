// Serves GET /api/openapi.json — canonical machine-readable contract for agent discovery.
// Used by AgentCash, x402scan, and mppscan. Response schemas required for L3 compliance.

import { Hono } from "hono";
import { PRICING } from "../config/pricing";
import type { Variables } from "../types";

const openapi = new Hono<{ Variables: Variables }>();

const pay = (k: string, payTo: string, network: string) => ({
  "x-payment-info": {
    price: { mode: "fixed", currency: "USD", amount: PRICING[k].usdAmount },
    protocols: [
      { x402: { network, payTo } },
      { mpp: { method: "tempo", intent: "charge", currency: "USDC" } },
    ],
  },
});

const r200 = (schema: unknown) => ({
  "200": { description: "Success", content: { "application/json": { schema } } },
  "402": { description: "Payment Required" },
  "503": { description: "Upstream unavailable" },
});

openapi.get("/openapi.json", (c) => {
  const env = c.get("env");
  const base = env.BASE_URL;
  const payTo = env.EVM_PAYEE_ADDRESS;
  const network = "eip155:8453";

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
          summary: "Live market vitals — BTC/ETH price, 24h change, volume",
          tags: ["Trading"],
          parameters: [{ in: "query", name: "symbols", required: false, schema: { type: "string", default: "btc,eth", enum: ["btc", "eth", "btc,eth"] }, description: "Comma-separated symbols to return. Default: btc,eth" }],
          ...pay("trading.vitals", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string", example: "trading_engine" },
              data: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  engine_status: { type: "string" },
                  btc: {
                    type: "object",
                    properties: {
                      price_usd: { type: "number" },
                      change_24h_pct: { type: "number" },
                      high_24h: { type: "number" },
                      low_24h: { type: "number" },
                      volume_24h: { type: "number" },
                    },
                  },
                  eth: {
                    type: "object",
                    properties: {
                      price_usd: { type: "number" },
                      change_24h_pct: { type: "number" },
                      volume_24h: { type: "number" },
                    },
                  },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/trading/engine/orderbook-depth": {
        get: {
          operationId: "tradingOrderbookDepth",
          summary: "Orderbook depth — CEX bids/asks, spread, imbalance",
          tags: ["Trading"],
          parameters: [{ in: "query", name: "pair", schema: { type: "string", example: "BTC/USDT" }, description: "Trading pair (default: BTC/USDT)" }],
          ...pay("trading.orderbookDepth", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  pair: { type: "string" },
                  best_bid: { type: "number" },
                  best_ask: { type: "number" },
                  spread_usd: { type: "number" },
                  spread_pct: { type: "number" },
                  bid_depth_top10: { type: "number" },
                  ask_depth_top10: { type: "number" },
                  imbalance: { type: "number", description: "-1 to 1, negative = ask-heavy" },
                  bids: { type: "array", items: { type: "array", items: { type: "number" } } },
                  asks: { type: "array", items: { type: "array", items: { type: "number" } } },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/trading/engine/mev-risk-index": {
        get: {
          operationId: "tradingMevRisk",
          summary: "MEV risk index — sandwich attack probability for current Base block",
          tags: ["Trading"],
          parameters: [],
          ...pay("trading.mevRiskIndex", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  risk_score: { type: "number", minimum: 0, maximum: 100 },
                  risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
                  block_number: { type: "number" },
                  total_txs: { type: "number" },
                  high_gas_txs: { type: "number" },
                  high_gas_ratio_pct: { type: "number" },
                  max_same_sender_txs: { type: "number" },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/trading/engine/funding-rates": {
        get: {
          operationId: "tradingFundingRates",
          summary: "Perpetual futures funding rates — BTC, ETH, SOL",
          tags: ["Trading"],
          parameters: [{ in: "query", name: "symbols", required: false, schema: { type: "string", default: "" }, description: "Comma-separated filter: BTC,ETH,SOL. Omit for all three." }],
          ...pay("trading.fundingRates", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  rates: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        symbol: { type: "string" },
                        funding_rate: { type: "number" },
                        rate_pct: { type: "string" },
                        annualized_pct: { type: "number" },
                        next_funding_ms: { type: "number" },
                        mark_price: { type: "number" },
                        index_price: { type: "number" },
                      },
                    },
                  },
                  btc_annualized_pct: { type: "number" },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/trading/engine/whale-tracker": {
        get: {
          operationId: "tradingWhaleTracker",
          summary: "On-chain large USDC transfer tracker — Base, above $500K",
          tags: ["Trading"],
          parameters: [{ in: "query", name: "threshold", required: false, schema: { type: "number", minimum: 10000, default: 500000 }, description: "Minimum USDC transfer amount in USD. Default: 500000" }],
          ...pay("trading.whaleTracker", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  source: { type: "string" },
                  large_transfers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        hash: { type: "string" },
                        from: { type: "string" },
                        to: { type: "string" },
                        amount_usdc: { type: "number" },
                        block_number: { type: "number" },
                        age_seconds: { type: "number" },
                      },
                    },
                  },
                  total_found: { type: "number" },
                  threshold_usd: { type: "number" },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/coding/cache/dependency-tree": {
        post: {
          operationId: "codingDependencyTree",
          summary: "Parse import/export dependency graph from source code",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, filename: { type: "string" } } } } } },
          ...pay("coding.dependencyTree", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  imports: { type: "array", items: { type: "string" } },
                  exports: { type: "array", items: { type: "string" } },
                  depth: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/coding/cache/token-compressor": {
        post: {
          operationId: "codingTokenCompressor",
          summary: "Strip comments and whitespace to minimize LLM token usage",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["raw_code"], properties: { raw_code: { type: "string" } } } } } },
          ...pay("coding.tokenCompressor", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  compressed: { type: "string" },
                  ratio_pct: { type: "number" },
                  original_bytes: { type: "number" },
                  compressed_bytes: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/coding/cache/syntax-heartbeat": {
        post: {
          operationId: "codingSyntaxHeartbeat",
          summary: "Validate JS/TS/JSX syntax — returns parse errors with position hints",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } } } },
          ...pay("coding.syntaxHeartbeat", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  valid: { type: "boolean" },
                  errors: { type: "array", items: { type: "string" } },
                  warnings: { type: "array", items: { type: "string" } },
                  lines: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/coding/cache/refactor-suggest": {
        post: {
          operationId: "codingRefactorSuggest",
          summary: "LLM-powered refactor suggestions with severity ratings",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string", default: "typescript" } } } } } },
          ...pay("coding.refactorSuggest", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  suggestions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        type: { type: "string" },
                        line_hint: { type: "number", nullable: true },
                        description: { type: "string" },
                        severity: { type: "string", enum: ["low", "medium", "high"] },
                      },
                    },
                  },
                  overall_quality: { type: "string", enum: ["poor", "fair", "good", "excellent"] },
                  summary: { type: "string" },
                },
              },
            },
          }),
        },
      },

      "/v1/coding/cache/security-audit": {
        post: {
          operationId: "codingSecurityAudit",
          summary: "Static security audit — detect SQL injection, XSS, hardcoded secrets",
          tags: ["Coding"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, language: { type: "string", default: "typescript" } } } } } },
          ...pay("coding.securityAudit", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  vulnerabilities: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
                        title: { type: "string" },
                        description: { type: "string" },
                        line_hint: { type: "number", nullable: true },
                        recommendation: { type: "string" },
                      },
                    },
                  },
                  risk_score: { type: "number", minimum: 0, maximum: 100 },
                  summary: { type: "string" },
                },
              },
            },
          }),
        },
      },

      "/v1/analysis/memory/heartbeat": {
        post: {
          operationId: "analysisHeartbeat",
          summary: "Cosine similarity between two texts using sentence embeddings",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text_a", "text_b"], properties: { text_a: { type: "string" }, text_b: { type: "string" } } } } } },
          ...pay("analysis.heartbeat", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  similarity: { type: "number", minimum: -1, maximum: 1 },
                  similarity_pct: { type: "number" },
                  vector_dims: { type: "number" },
                  interpretation: { type: "string", enum: ["distinct", "related", "very similar"] },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/analysis/memory/entity-extractor": {
        post: {
          operationId: "analysisEntityExtractor",
          summary: "Extract named entities — persons, orgs, dates, locations, money",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
          ...pay("analysis.entityExtractor", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  entities: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        type: { type: "string", enum: ["PERSON", "ORG", "LOC", "DATE", "MONEY", "PRODUCT", "OTHER"] },
                        confidence: { type: "string", enum: ["low", "medium", "high"] },
                      },
                    },
                  },
                  entity_count: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/analysis/memory/context-ranker": {
        post: {
          operationId: "analysisContextRanker",
          summary: "Re-rank text chunks by semantic relevance to a query",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["query", "chunks"], properties: { query: { type: "string" }, chunks: { type: "array", items: { type: "string" } } } } } } },
          ...pay("analysis.contextRanker", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  ranked: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        index: { type: "number" },
                        chunk: { type: "string" },
                        score: { type: "number" },
                      },
                    },
                  },
                  query_vector_dims: { type: "number" },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },

      "/v1/analysis/memory/bias-detector": {
        post: {
          operationId: "analysisBiasDetector",
          summary: "Detect framing bias, sentiment slant, and loaded language",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } } } },
          ...pay("analysis.biasDetector", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  bias_detected: { type: "boolean" },
                  bias_types: { type: "array", items: { type: "string", enum: ["framing", "sentiment", "loaded_language", "omission", "selection"] } },
                  confidence: { type: "string", enum: ["low", "medium", "high"] },
                  bias_score: { type: "number", minimum: 0, maximum: 100 },
                  examples: {
                    type: "array",
                    items: { type: "object", properties: { phrase: { type: "string" }, type: { type: "string" }, explanation: { type: "string" } } },
                  },
                  summary: { type: "string" },
                },
              },
            },
          }),
        },
      },

      "/v1/analysis/memory/fact-linkage": {
        post: {
          operationId: "analysisFactLinkage",
          summary: "Verify claims via fact-check databases + LLM fallback",
          tags: ["Analysis"],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["claim"], properties: { claim: { type: "string" }, language: { type: "string", default: "en" } } } } } },
          ...pay("analysis.factLinkage", payTo, network),
          responses: r200({
            type: "object",
            properties: {
              success: { type: "boolean" },
              bundle: { type: "string" },
              data: {
                type: "object",
                properties: {
                  source: { type: "string", enum: ["google_factcheck", "llm"] },
                  claims: {
                    type: "array",
                    description: "Present when source=google_factcheck",
                    items: {
                      type: "object",
                      properties: {
                        claim_text: { type: "string" },
                        claimant: { type: "string" },
                        reviews: {
                          type: "array",
                          items: { type: "object", properties: { publisher: { type: "string" }, url: { type: "string" }, rating: { type: "string" } } },
                        },
                      },
                    },
                  },
                  assessment: { type: "string", enum: ["likely_true", "likely_false", "misleading", "unverifiable"], description: "Present when source=llm" },
                  confidence: { type: "string", enum: ["low", "medium", "high"] },
                  reasoning: { type: "string" },
                  timestamp: { type: "number" },
                },
              },
            },
          }),
        },
      },
    },
    tags: [
      { name: "Trading", description: "Non-Stop AI Trading Engine — CEX + on-chain hybrid data" },
      { name: "Coding",  description: "Coding Cache — AST analysis, compression, LLM security audits" },
      { name: "Analysis", description: "Live Vector Pruner — embeddings, entities, fact verification" },
    ],
  });
});

export default openapi;
