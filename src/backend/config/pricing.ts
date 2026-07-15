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
  // Short-term additions
  "trading.gasTracker":         { usdAmount: "0.020000", atomicUsdc: "20000" },
  "trading.tokenScreener":      { usdAmount: "0.050000", atomicUsdc: "50000" },
  "coding.secretScanner":       { usdAmount: "0.040000", atomicUsdc: "40000" },
  "analysis.sentiment":         { usdAmount: "0.030000", atomicUsdc: "30000" },
  // Web Intelligence
  "web.urlMetadata":            { usdAmount: "0.030000", atomicUsdc: "30000" },
  "web.articleParser":          { usdAmount: "0.050000", atomicUsdc: "50000" },
  "web.linkExtractor":          { usdAmount: "0.030000", atomicUsdc: "30000" },
  // On-chain Intelligence
  "onchain.walletRisk":         { usdAmount: "0.060000", atomicUsdc: "60000" },
  "onchain.contractSummary":    { usdAmount: "0.070000", atomicUsdc: "70000" },
  "onchain.txClassifier":       { usdAmount: "0.040000", atomicUsdc: "40000" },
  "onchain.tokenHolders":       { usdAmount: "0.050000", atomicUsdc: "50000" },
  // Agent Memory
  "agent.store":                { usdAmount: "0.010000", atomicUsdc: "10000" },
  "agent.recall":               { usdAmount: "0.030000", atomicUsdc: "30000" },
  "agent.forget":               { usdAmount: "0.005000", atomicUsdc: "5000"  },
  "agent.list":                 { usdAmount: "0.010000", atomicUsdc: "10000" },
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
  "/api/v1/trading/engine/gas-tracker":         PRICING["trading.gasTracker"],
  "/api/v1/trading/engine/token-screener":      PRICING["trading.tokenScreener"],
  "/api/v1/coding/cache/secret-scanner":        PRICING["coding.secretScanner"],
  "/api/v1/analysis/memory/sentiment":          PRICING["analysis.sentiment"],
  // Web Intelligence
  "/api/v1/web/intelligence/url-metadata":      PRICING["web.urlMetadata"],
  "/api/v1/web/intelligence/article-parser":    PRICING["web.articleParser"],
  "/api/v1/web/intelligence/link-extractor":    PRICING["web.linkExtractor"],
  // On-chain Intelligence
  "/api/v1/onchain/wallet-risk-score":          PRICING["onchain.walletRisk"],
  "/api/v1/onchain/contract-summary":           PRICING["onchain.contractSummary"],
  "/api/v1/onchain/tx-classifier":              PRICING["onchain.txClassifier"],
  "/api/v1/onchain/token-holders":              PRICING["onchain.tokenHolders"],
  // Agent Memory
  "/api/v1/agent/memory/store":                 PRICING["agent.store"],
  "/api/v1/agent/memory/recall":                PRICING["agent.recall"],
  "/api/v1/agent/memory/forget":                PRICING["agent.forget"],
  "/api/v1/agent/memory/list":                  PRICING["agent.list"],
};
