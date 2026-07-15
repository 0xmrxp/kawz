// Bundle: On-chain Intelligence (4 endpoints)
// Blockscout REST API + Base RPC + LLM summaries.
// Env deps: BLOCKSCOUT_BASE_URL, BASE_RPC_URL, LLM_BASE_URL, LLM_MODEL, GROQ_API_KEY.

import { Hono } from "hono";
import type { Variables } from "../types";
import { getOrFetch } from "../lib/cache";
import { getLLMConfig, llmChat } from "../lib/llm";

const onchain = new Hono<{ Variables: Variables }>();

const TTL = {
  walletRisk:      120,
  contractSummary: 3600,
  txClassifier:    3600,
  tokenHolders:    120,
} as const;

// ─── Validators ──────────────────────────────────────────────────────────────

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);
const isTxHash  = (v: string) => /^0x[0-9a-fA-F]{64}$/i.test(v);

// ─── Function-selector map for tx-classifier ─────────────────────────────────

const SELECTORS: Record<string, { type: string; protocol: string }> = {
  "0x7ff36ab5": { type: "swap",             protocol: "Uniswap V2"     },
  "0x38ed1739": { type: "swap",             protocol: "Uniswap V2"     },
  "0x414bf389": { type: "swap",             protocol: "Uniswap V3"     },
  "0xc04b8d59": { type: "swap",             protocol: "Uniswap V3"     },
  "0x56688700": { type: "bridge",           protocol: "Base Bridge"    },
  "0x1249c58b": { type: "nft_mint",         protocol: "ERC-721"        },
  "0x095ea7b3": { type: "token_approval",   protocol: "ERC-20"         },
  "0xa22cb465": { type: "nft_approval",     protocol: "ERC-721"        },
};

// ─── GET /wallet-risk-score ──────────────────────────────────────────────────

onchain.get("/wallet-risk-score", async (c) => {
  const env     = c.get("env");
  const address = c.req.query("address") ?? "";

  if (!isAddress(address)) {
    return c.json({ success: false, error: "invalid or missing address" }, 400);
  }

  const cacheKey = `onchain:wallet-risk:${address.toLowerCase()}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      () => fetchWalletRisk(env.BLOCKSCOUT_BASE_URL, address),
      { ttlSeconds: TTL.walletRisk }
    );
    return c.json({ success: true, bundle: "onchain_intelligence", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchWalletRisk(blockscoutBaseUrl: string, address: string) {
  const url =
    `${blockscoutBaseUrl}/api?module=account&action=txlist` +
    `&address=${address}&sort=desc&offset=100&page=1`;

  const res  = await fetch(url, { headers: { Accept: "application/json" } });
  const json = (await res.json()) as { status: string; result?: Record<string, string>[] };

  if (json.status !== "1" || !Array.isArray(json.result)) {
    return {
      source:           "blockscout_base",
      address,
      tx_count:         0,
      failed_tx_ratio:  0,
      burst_pattern:    false,
      risk_score:       0,
      risk_level:       "none",
      timestamp:        Date.now(),
    };
  }

  const txs        = json.result;
  const total      = txs.length;
  const failed     = txs.filter(tx => tx.isError === "1").length;
  const failedRatio = total > 0 ? failed / total : 0;

  // Burst pattern: more than 10 txs within any 60-second window
  const timestamps = txs.map(tx => parseInt(tx.timeStamp ?? "0")).sort((a, b) => a - b);
  let burstPattern = false;
  for (let i = 0; i < timestamps.length; i++) {
    const windowEnd = (timestamps[i] ?? 0) + 60;
    let count = 0;
    for (let j = i; j < timestamps.length && (timestamps[j] ?? 0) <= windowEnd; j++) count++;
    if (count > 10) { burstPattern = true; break; }
  }

  // Risk score: failed ratio contributes 60 pts, burst pattern 25 pts, volume 15 pts
  let score = Math.round(failedRatio * 60);
  if (burstPattern)   score += 25;
  if (total >= 100)   score += 15;
  score = Math.min(100, score);

  const risk_level =
    score === 0  ? "none"     :
    score < 20   ? "low"      :
    score < 50   ? "medium"   :
    score < 80   ? "high"     : "critical";

  return {
    source:          "blockscout_base",
    address,
    tx_count:        total,
    failed_txs:      failed,
    failed_tx_ratio: parseFloat(failedRatio.toFixed(4)),
    burst_pattern:   burstPattern,
    risk_score:      score,
    risk_level,
    timestamp:       Date.now(),
  };
}

// ─── GET /contract-summary ───────────────────────────────────────────────────

onchain.get("/contract-summary", async (c) => {
  const env     = c.get("env");
  const address = c.req.query("address") ?? "";

  if (!isAddress(address)) {
    return c.json({ success: false, error: "invalid or missing address" }, 400);
  }

  const cacheKey = `onchain:contract-summary:${address.toLowerCase()}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      () => fetchContractSummary(env.BLOCKSCOUT_BASE_URL, getLLMConfig(env), address),
      { ttlSeconds: TTL.contractSummary }
    );
    return c.json({ success: true, bundle: "onchain_intelligence", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchContractSummary(
  blockscoutBaseUrl: string,
  llmConfig: ReturnType<typeof getLLMConfig>,
  address: string
) {
  // Fetch source code (includes contract name + ABI)
  const srcUrl =
    `${blockscoutBaseUrl}/api?module=contract&action=getsourcecode&address=${address}`;
  const abiUrl =
    `${blockscoutBaseUrl}/api?module=contract&action=getabi&address=${address}`;

  const [srcRes, abiRes] = await Promise.all([
    fetch(srcUrl, { headers: { Accept: "application/json" } }),
    fetch(abiUrl, { headers: { Accept: "application/json" } }),
  ]);

  const srcJson = (await srcRes.json()) as {
    status: string;
    result?: { ContractName?: string; SourceCode?: string }[];
  };
  const abiJson = (await abiRes.json()) as { status: string; result?: string };

  const contractName = srcJson.result?.[0]?.ContractName ?? "Unknown";
  const sourceCode   = srcJson.result?.[0]?.SourceCode   ?? "";
  const abi          = abiJson.status === "1" ? (abiJson.result ?? "") : "";

  // Build a concise prompt — avoid sending full source code which may be huge
  const abiSnippet = abi.length > 2000 ? abi.slice(0, 2000) + "…" : abi;
  const srcSnippet = sourceCode.length > 1000 ? sourceCode.slice(0, 1000) + "…" : sourceCode;

  const summary = await llmChat(llmConfig, {
    messages: [
      {
        role: "system",
        content:
          "You are a smart-contract analyst. Given a contract name, partial ABI, and " +
          "optional source snippet, write 2-3 plain English sentences explaining what " +
          "the contract does and its primary purpose. Be concise and avoid jargon.",
      },
      {
        role: "user",
        content:
          `Contract: ${contractName}\nAddress: ${address}\n\nABI (truncated):\n${abiSnippet}` +
          (srcSnippet ? `\n\nSource (truncated):\n${srcSnippet}` : ""),
      },
    ],
    temperature: 0.2,
    maxTokens:   256,
  });

  return {
    source:        "blockscout_base",
    address,
    contract_name: contractName,
    summary,
    has_source:    sourceCode.length > 0,
    has_abi:       abi.length > 0,
    timestamp:     Date.now(),
  };
}

// ─── POST /tx-classifier ─────────────────────────────────────────────────────

onchain.post("/tx-classifier", async (c) => {
  const env = c.get("env");
  let body: { tx_hash?: string };
  try { body = await c.req.json(); } catch {
    return c.json({ success: false, error: "invalid JSON body" }, 400);
  }
  const { tx_hash } = body;
  if (!tx_hash || !isTxHash(tx_hash)) {
    return c.json({ success: false, error: "invalid or missing tx_hash" }, 400);
  }

  const cacheKey = `onchain:tx-classifier:${tx_hash.toLowerCase()}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      () => fetchTxClassifier(env.BASE_RPC_URL, tx_hash),
      { ttlSeconds: TTL.txClassifier }
    );
    return c.json({ success: true, bundle: "onchain_intelligence", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchTxClassifier(rpcUrl: string, txHash: string) {
  const res = await fetch(rpcUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method:  "eth_getTransactionByHash",
      params:  [txHash],
      id:      1,
    }),
  });

  const json = (await res.json()) as {
    result?: {
      input?: string;
      value?: string;
      from?:  string;
      to?:    string;
      blockNumber?: string;
    } | null;
  };

  const tx = json.result;
  if (!tx) {
    return {
      source:    "base_rpc",
      tx_hash:   txHash,
      type:      "unknown",
      protocol:  null,
      value_eth: 0,
      timestamp: Date.now(),
    };
  }

  const input    = tx.input ?? "0x";
  const selector = input.length >= 10 ? input.slice(0, 10).toLowerCase() : "0x";
  const match    = SELECTORS[selector];

  // Native ETH value in ether
  const valueWei = BigInt(tx.value ?? "0x0");
  const valueEth = Number(valueWei) / 1e18;

  // If no selector match, try to detect simple ETH transfer
  const isSimpleTransfer = input === "0x" || input === "";
  const type     = match?.type     ?? (isSimpleTransfer ? "transfer" : "unknown");
  const protocol = match?.protocol ?? (isSimpleTransfer ? "native"   : null);

  return {
    source:       "base_rpc",
    tx_hash:      txHash,
    selector,
    type,
    protocol,
    value_eth:    parseFloat(valueEth.toFixed(8)),
    from:         tx.from ?? null,
    to:           tx.to   ?? null,
    block_number: tx.blockNumber ? parseInt(tx.blockNumber, 16) : null,
    timestamp:    Date.now(),
  };
}

// ─── GET /token-holders ──────────────────────────────────────────────────────

onchain.get("/token-holders", async (c) => {
  const env     = c.get("env");
  const address = c.req.query("address") ?? "";
  const limit   = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "20")), 100);

  if (!isAddress(address)) {
    return c.json({ success: false, error: "invalid or missing address" }, 400);
  }

  const cacheKey = `onchain:token-holders:${address.toLowerCase()}:${limit}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      () => fetchTokenHolders(env.BLOCKSCOUT_BASE_URL, address, limit),
      { ttlSeconds: TTL.tokenHolders }
    );
    return c.json({ success: true, bundle: "onchain_intelligence", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

// Gini coefficient for an array of non-negative numbers (0 = perfect equality, 1 = total inequality)
function giniCoefficient(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n      = sorted.length;
  const sum    = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) numerator += (2 * (i + 1) - n - 1) * (sorted[i] ?? 0);
  return parseFloat((numerator / (n * sum)).toFixed(4));
}

async function fetchTokenHolders(blockscoutBaseUrl: string, address: string, limit: number) {
  const url =
    `${blockscoutBaseUrl}/api?module=token&action=getTokenHolders` +
    `&contractaddress=${address}&offset=${limit}&page=1`;

  const res  = await fetch(url, { headers: { Accept: "application/json" } });
  const json = (await res.json()) as {
    status: string;
    result?: { address?: string; value?: string }[];
  };

  if (json.status !== "1" || !Array.isArray(json.result)) {
    return {
      source:            "blockscout_base",
      token_address:     address,
      holders:           [],
      holder_count:      0,
      gini_coefficient:  null,
      timestamp:         Date.now(),
    };
  }

  const holders = json.result.map(h => ({
    address: h.address ?? "",
    balance: h.value   ?? "0",
  }));

  const balances      = holders.map(h => parseFloat(h.balance));
  const gini          = giniCoefficient(balances);
  const totalSupply   = balances.reduce((a, b) => a + b, 0);

  const holdersWithPct = holders.map(h => ({
    ...h,
    share_pct: totalSupply > 0
      ? parseFloat(((parseFloat(h.balance) / totalSupply) * 100).toFixed(4))
      : 0,
  }));

  return {
    source:           "blockscout_base",
    token_address:    address,
    holders:          holdersWithPct,
    holder_count:     holders.length,
    gini_coefficient: gini,
    timestamp:        Date.now(),
  };
}

export default onchain;
