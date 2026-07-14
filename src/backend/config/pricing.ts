export interface EndpointPrice {
  usdAmount: string;   // decimal USD string for OpenAPI x-payment-info
  atomicUsdc: string;  // USDC atomic units (6 decimals): $0.002 → "2000"
}

export const PRICING: Record<string, EndpointPrice> = {
  "trading.vitals":             { usdAmount: "0.002000", atomicUsdc: "2000" },
  "trading.orderbookDepth":     { usdAmount: "0.005000", atomicUsdc: "5000" },
  "trading.mevRiskIndex":       { usdAmount: "0.004000", atomicUsdc: "4000" },
  "trading.fundingRates":       { usdAmount: "0.002000", atomicUsdc: "2000" },
  "trading.whaleTracker":       { usdAmount: "0.008000", atomicUsdc: "8000" },
  "coding.dependencyTree":      { usdAmount: "0.003000", atomicUsdc: "3000" },
  "coding.tokenCompressor":     { usdAmount: "0.002000", atomicUsdc: "2000" },
  "coding.syntaxHeartbeat":     { usdAmount: "0.002000", atomicUsdc: "2000" },
  "coding.refactorSuggest":     { usdAmount: "0.005000", atomicUsdc: "5000" },
  "coding.securityAudit":       { usdAmount: "0.006000", atomicUsdc: "6000" },
  "analysis.heartbeat":         { usdAmount: "0.003000", atomicUsdc: "3000" },
  "analysis.entityExtractor":   { usdAmount: "0.006000", atomicUsdc: "6000" },
  "analysis.contextRanker":     { usdAmount: "0.005000", atomicUsdc: "5000" },
  "analysis.biasDetector":      { usdAmount: "0.005000", atomicUsdc: "5000" },
  "analysis.factLinkage":       { usdAmount: "0.012000", atomicUsdc: "12000" },
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
};
