export interface Env {
  ENVIRONMENT: "development" | "production";
  BASE_URL: string;
  PORT: string;
  REDIS_URL: string;
  GROQ_API_KEY: string;
  QDRANT_URL: string;
  CDP_API_KEY_ID: string;
  CDP_API_KEY_SECRET: string;
  EVM_PAYEE_ADDRESS: string;
  MPP_OPERATOR_KEY: string;
  MPP_FEE_PAYER_KEY?: string;
  MPP_SECRET_KEY: string;
  MPP_TEMPO_USDC_ADDRESS: string;
  // On-chain data sources (optional — sensible public defaults provided)
  BLOCKSCOUT_BASE_URL: string;
  BASE_RPC_URL: string;
  // ETH RPC providers for gas-tracker (optional — public RPC fallbacks used if empty)
  ETH_RPC_ALCHEMY:    string;  // https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
  ETH_RPC_QUICKNODE:  string;  // https://xxx.quiknode.pro/xxx/
  ETH_RPC_INFURA:     string;  // https://mainnet.infura.io/v3/YOUR_KEY
  // Google Fact Check Tools API key (free, optional — fallback to LLM if empty)
  GOOGLE_FACTCHECK_API_KEY: string;
  // Ollama self-hosted LLM (primary inference engine)
  LLM_BASE_URL: string;   // e.g. "http://localhost:11434"
  LLM_MODEL:    string;   // e.g. "qwen2.5:3b"
}

// Hono Variables type — injected via app.use("*") in server.ts
export type Variables = { env: Env };

export function loadEnv(): Env {
  const environment = (process.env.ENVIRONMENT ?? "development") as Env["ENVIRONMENT"];

  // In production every critical var must be present — fail fast at startup.
  if (environment === "production") {
    const required: (keyof Env)[] = [
      "BASE_URL", "REDIS_URL", "QDRANT_URL",
      "EVM_PAYEE_ADDRESS", "MPP_SECRET_KEY", "MPP_TEMPO_USDC_ADDRESS",
    ];
    for (const key of required) {
      if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
    }
  }

  return {
    ENVIRONMENT: environment,
    BASE_URL: process.env.BASE_URL ?? "http://localhost:3000",
    PORT: process.env.PORT ?? "3000",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    GROQ_API_KEY: process.env.GROQ_API_KEY ?? "",
    QDRANT_URL: process.env.QDRANT_URL ?? "http://localhost:6333",
    CDP_API_KEY_ID: process.env.CDP_API_KEY_ID ?? "",
    CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET ?? "",
    EVM_PAYEE_ADDRESS: process.env.EVM_PAYEE_ADDRESS ?? "0x0000000000000000000000000000000000000000",
    MPP_OPERATOR_KEY: process.env.MPP_OPERATOR_KEY ?? "",
    MPP_FEE_PAYER_KEY: process.env.MPP_FEE_PAYER_KEY,
    MPP_SECRET_KEY: process.env.MPP_SECRET_KEY ?? "",
    MPP_TEMPO_USDC_ADDRESS: process.env.MPP_TEMPO_USDC_ADDRESS ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    BLOCKSCOUT_BASE_URL: process.env.BLOCKSCOUT_BASE_URL ?? "https://base.blockscout.com",
    BASE_RPC_URL: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    ETH_RPC_ALCHEMY:   process.env.ETH_RPC_ALCHEMY   ?? "",
    ETH_RPC_QUICKNODE: process.env.ETH_RPC_QUICKNODE ?? "",
    ETH_RPC_INFURA:    process.env.ETH_RPC_INFURA    ?? "",
    GOOGLE_FACTCHECK_API_KEY: process.env.GOOGLE_FACTCHECK_API_KEY ?? "",
    LLM_BASE_URL: process.env.LLM_BASE_URL ?? "http://localhost:11434",
    LLM_MODEL:    process.env.LLM_MODEL    ?? "qwen2.5:3b",
  };
}
