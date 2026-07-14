export interface EndpointPrice {
  usdAmount: string;   // decimal USD string for OpenAPI x-payment-info
  atomicUsdc: string;  // USDC atomic units (6 decimals): $0.002 → "2000"
}

export const PRICING: Record<string, EndpointPrice> = {
  // Trading Intelligence
  "trading.vitals":             { usdAmount: "0.030000", atomicUsdc: "30000" },
  "trading.orderbookDepth":     { usdAmount: "0.050000", atomicUsdc: "50000" },
  "trading.mevRiskIndex":       { usdAmount: "0.040000", atomicUsdc: "40000" },
  "trading.fundingRates":       { usdAmount: "0.030000", atomicUsdc: "30000" },
  "trading.whaleTracker":       { usdAmount: "0.080000", atomicUsdc: "80000" },
  // Coding Cache
  "coding.dependencyTree":      { usdAmount: "0.030000", atomicUsdc: "30000" },
  "coding.tokenCompressor":     { usdAmount: "0.030000", atomicUsdc: "30000" },
  "coding.syntaxHeartbeat":     { usdAmount: "0.030000", atomicUsdc: "30000" },
  "coding.refactorSuggest":     { usdAmount: "0.050000", atomicUsdc: "50000" },
  "coding.securityAudit":       { usdAmount: "0.060000", atomicUsdc: "60000" },
  // Research Pruner
  "analysis.heartbeat":         { usdAmount: "0.030000", atomicUsdc: "30000" },
  "analysis.entityExtractor":   { usdAmount: "0.060000", atomicUsdc: "60000" },
  "analysis.contextRanker":     { usdAmount: "0.050000", atomicUsdc: "50000" },
  "analysis.biasDetector":      { usdAmount: "0.050000", atomicUsdc: "50000" },
  "analysis.factLinkage":       { usdAmount: "0.120000", atomicUsdc: "120000" },
  // MCP server — per-request flat rate
  "mcp.request":                { usdAmount: "0.030000", atomicUsdc: "30000" },
};

// Route path → pricing key map — used by payment middleware in server.ts
export const ROUTE_PRICE_MAP: Record<string, EndpointPrice> = {
  "/api/v1/trading/engine/vitals":              PRICING["trading.vitals"],
  "/api/v1/trading/engine/orderbook-depth":     PRICING["trading.orderbookDepth"],
  "/api/v1/trading/engine/mev-risk-index":      PRICING["trading.mevRiskIndex"],
  "/api/v1/trading/engine/funding-rates":       PRICING["trading.fundingRates"],
  "/api/v1/trading/engine/whale-tracker":       PRICING["trading.whaleTracker"],
  "/api/v1/coding/cache/dependency-tree":       PRICING["coding.dependencyTree"],
  "/api/v1/coding/cache/token-compressor":      PRICING["coding.tokenCompressor"],
  "/api/v1/coding/cache/syntax-heartbeat":      PRICING["coding.syntaxHeartbeat"],
  "/api/v1/coding/cache/refactor-suggest":      PRICING["coding.refactorSuggest"],
  "/api/v1/coding/cache/security-audit":        PRICING["coding.securityAudit"],
  "/api/v1/analysis/memory/heartbeat":          PRICING["analysis.heartbeat"],
  "/api/v1/analysis/memory/entity-extractor":   PRICING["analysis.entityExtractor"],
  "/api/v1/analysis/memory/context-ranker":     PRICING["analysis.contextRanker"],
  "/api/v1/analysis/memory/bias-detector":      PRICING["analysis.biasDetector"],
  "/api/v1/analysis/memory/fact-linkage":       PRICING["analysis.factLinkage"],
  "/api/mcp":                                   PRICING["mcp.request"],
};
