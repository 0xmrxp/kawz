// Bundle 1: Non-Stop AI Trading Engine (5 endpoints)
// CEX data: CCXT Binance (public, no key needed)
// On-chain data: Blockscout Base + Base mainnet public RPC
// CoinGecko: fallback for vitals if CCXT is unavailable

import { Hono } from "hono";
import { binance as Binance } from "ccxt";
import type { Variables } from "../types";
import { getOrFetch } from "../lib/cache";

const trading = new Hono<{ Variables: Variables }>();

// Redis TTLs tuned to data volatility + upstream rate limits
const TTL = {
  vitals:       10,
  orderbook:     5,
  mevRisk:      30,
  fundingRates: 15,
  whaleTracks:  60,
} as const;

// ─── CCXT singletons ─────────────────────────────────────────────────────────
// Reused across requests — avoids re-initialising on every call and shares rate-limit state.

let _spot: InstanceType<typeof Binance> | null = null;
function spot(): InstanceType<typeof Binance> {
  if (!_spot) _spot = new Binance({ enableRateLimit: true });
  return _spot;
}

// Generic singleton map for exchanges used by token-screener.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _exchangeCache = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getExchange(name: string): any {
  if (!_exchangeCache.has(name)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ExClass = (ccxt as any)[name];
    if (!ExClass) throw new Error(`unknown exchange: ${name}`);
    _exchangeCache.set(name, new ExClass({ enableRateLimit: true }));
  }
  return _exchangeCache.get(name);
}

// ─── /vitals ─────────────────────────────────────────────────────────────────

trading.get("/vitals", async (c) => {
  const env = c.get("env");
  const symbolsRaw = (c.req.query("symbols") ?? "btc,eth").toLowerCase();
  const symbols = symbolsRaw.split(",").map(s => s.trim()).filter(s => s === "btc" || s === "eth");
  const want = symbols.length > 0 ? symbols : ["btc", "eth"];
  try {
    const full = await getOrFetch(
      env.REDIS_URL, "trading:vitals", fetchVitals, { ttlSeconds: TTL.vitals }
    );
    const data: Record<string, unknown> = {
      source: full.source, engine_status: full.engine_status, timestamp: full.timestamp,
    };
    if (want.includes("btc")) data.btc = full.btc;
    if (want.includes("eth")) data.eth = full.eth;
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchVitals() {
  try {
    const [btc, eth] = await Promise.all([
      spot().fetchTicker("BTC/USDT"),
      spot().fetchTicker("ETH/USDT"),
    ]);
    return {
      source: "binance",
      engine_status: "synchronized",
      btc: {
        price_usd:     btc.last,
        change_24h_pct: btc.percentage,
        high_24h:      btc.high,
        low_24h:       btc.low,
        volume_24h:    btc.baseVolume,
      },
      eth: {
        price_usd:     eth.last,
        change_24h_pct: eth.percentage,
        high_24h:      eth.high,
        low_24h:       eth.low,
        volume_24h:    eth.baseVolume,
      },
      timestamp: Date.now(),
    };
  } catch {
    // CoinGecko fallback — free, no API key, 100 calls/min
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum" +
      "&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true"
    );
    const d = (await res.json()) as Record<string, Record<string, number>>;
    return {
      source: "coingecko",
      engine_status: "synchronized",
      btc: {
        price_usd:     d.bitcoin?.usd,
        change_24h_pct: d.bitcoin?.usd_24h_change,
        volume_24h:    d.bitcoin?.usd_24h_vol,
      },
      eth: {
        price_usd:     d.ethereum?.usd,
        change_24h_pct: d.ethereum?.usd_24h_change,
        volume_24h:    d.ethereum?.usd_24h_vol,
      },
      timestamp: Date.now(),
    };
  }
}

// ─── /orderbook-depth ────────────────────────────────────────────────────────

trading.get("/orderbook-depth", async (c) => {
  const env = c.get("env");
  const pair = (c.req.query("pair") ?? "BTC/USDT").toUpperCase();
  const cacheKey = `trading:orderbook:${pair.replace("/", "-")}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey, () => fetchOrderbookDepth(pair), { ttlSeconds: TTL.orderbook }
    );
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchOrderbookDepth(pair: string) {
  const ob = await spot().fetchOrderBook(pair, 20);
  const bestBid = ob.bids[0]?.[0] ?? 0;
  const bestAsk = ob.asks[0]?.[0] ?? 0;
  const spread  = bestAsk - bestBid;

  const bidDepth = ob.bids.slice(0, 10).reduce((s, [, v]) => s + (v ?? 0), 0);
  const askDepth = ob.asks.slice(0, 10).reduce((s, [, v]) => s + (v ?? 0), 0);

  return {
    source: "binance",
    pair,
    best_bid:         bestBid,
    best_ask:         bestAsk,
    spread_usd:       parseFloat(spread.toFixed(4)),
    spread_pct:       bestBid > 0 ? parseFloat(((spread / bestBid) * 100).toFixed(4)) : 0,
    bid_depth_top10:  parseFloat(bidDepth.toFixed(4)),
    ask_depth_top10:  parseFloat(askDepth.toFixed(4)),
    imbalance:        bidDepth + askDepth > 0
                        ? parseFloat(((bidDepth - askDepth) / (bidDepth + askDepth)).toFixed(4))
                        : 0,
    bids: ob.bids.slice(0, 10),
    asks: ob.asks.slice(0, 10),
    timestamp: Date.now(),
  };
}

// ─── /funding-rates ──────────────────────────────────────────────────────────

trading.get("/funding-rates", async (c) => {
  const env = c.get("env");
  const symbolsRaw = c.req.query("symbols") ?? "";
  const filterSymbols = symbolsRaw
    ? symbolsRaw.toUpperCase().split(",").map(s => s.trim()).filter(Boolean)
    : [];
  try {
    const full = await getOrFetch(
      env.REDIS_URL, "trading:funding-rates", fetchFundingRates, { ttlSeconds: TTL.fundingRates }
    );
    const data = filterSymbols.length === 0 ? full : {
      ...full,
      rates: (full.rates as { symbol?: string }[]).filter(r =>
        filterSymbols.some(s => String(r.symbol ?? "").includes(s))
      ),
    };
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchFundingRates() {
  const pairs = ["BTC/USDT:USDT", "ETH/USDT:USDT", "SOL/USDT:USDT"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settled = await Promise.allSettled(pairs.map((p) => (spot() as any).fetchFundingRate(p)));

  const rates = settled
    .filter((r): r is PromiseFulfilledResult<Record<string, number | string | undefined>> =>
      r.status === "fulfilled"
    )
    .map((r) => {
      const v = r.value;
      const fr = typeof v.fundingRate === "number" ? v.fundingRate : 0;
      return {
        symbol:            v.symbol,
        funding_rate:      fr,
        rate_pct:          `${(fr * 100).toFixed(4)}%`,
        annualized_pct:    parseFloat((fr * 3 * 365 * 100).toFixed(2)),
        next_funding_ms:   v.fundingTimestamp,
        mark_price:        v.markPrice,
        index_price:       v.indexPrice,
      };
    });

  const btcRate = rates.find((r) => String(r.symbol).includes("BTC"))?.funding_rate ?? 0;
  return {
    source: "binance_futures",
    rates,
    btc_annualized_pct: parseFloat((Number(btcRate) * 3 * 365 * 100).toFixed(2)),
    timestamp: Date.now(),
  };
}

// ─── /whale-tracker ──────────────────────────────────────────────────────────

trading.get("/whale-tracker", async (c) => {
  const env = c.get("env");
  const thresholdRaw = c.req.query("threshold");
  const threshold = thresholdRaw ? Math.max(10000, parseInt(thresholdRaw)) : WHALE_THRESHOLD;
  const cacheKey = threshold === WHALE_THRESHOLD
    ? "trading:whale-tracker"
    : `trading:whale-tracker:${threshold}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      () => fetchWhaleTransfers(env.BLOCKSCOUT_BASE_URL, threshold),
      { ttlSeconds: TTL.whaleTracks }
    );
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

const USDC_BASE       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WHALE_THRESHOLD = 500_000; // USDC

async function fetchWhaleTransfers(blockscoutBaseUrl: string, threshold = WHALE_THRESHOLD) {
  const url =
    `${blockscoutBaseUrl}/api?module=account&action=tokentx` +
    `&contractaddress=${USDC_BASE}&sort=desc&offset=100&page=1`;

  const res  = await fetch(url, { headers: { Accept: "application/json" } });
  const json = (await res.json()) as { status: string; result?: Record<string, string>[] };

  if (json.status !== "1" || !Array.isArray(json.result)) {
    return {
      source: "blockscout_base",
      large_transfers: [],
      threshold_usd: WHALE_THRESHOLD,
      timestamp: Date.now(),
    };
  }

  const whales = json.result
    .filter((tx) => parseInt(tx.value ?? "0") / 1e6 >= threshold)
    .slice(0, 25)
    .map((tx) => ({
      hash:         tx.hash,
      from:         tx.from,
      to:           tx.to,
      amount_usdc:  parseInt(tx.value ?? "0") / 1e6,
      block_number: parseInt(tx.blockNumber ?? "0"),
      age_seconds:  Math.floor(Date.now() / 1000) - parseInt(tx.timeStamp ?? "0"),
    }));

  return {
    source:          "blockscout_base",
    large_transfers: whales,
    total_found:     whales.length,
    threshold_usd:   threshold,
    timestamp:       Date.now(),
  };
}

// ─── /mev-risk-index ─────────────────────────────────────────────────────────

trading.get("/mev-risk-index", async (c) => {
  const env = c.get("env");
  try {
    const data = await getOrFetch(
      env.REDIS_URL, "trading:mev-risk-index",
      () => fetchMevRiskIndex(env.BASE_RPC_URL),
      { ttlSeconds: TTL.mevRisk }
    );
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchMevRiskIndex(rpcUrl: string) {
  const rpcRes = await fetch(rpcUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method:  "eth_getBlockByNumber",
      params:  ["latest", true],
      id: 1,
    }),
  });

  const { result: block } = (await rpcRes.json()) as { result: Record<string, unknown> };
  const txs = (block?.transactions ?? []) as Record<string, string>[];
  const totalTxs = txs.length;

  if (totalTxs < 3) {
    return {
      source:      "base_rpc",
      risk_score:  0,
      risk_level:  "low",
      block_number: parseInt((block?.number as string) ?? "0x0", 16),
      total_txs:   totalTxs,
      timestamp:   Date.now(),
    };
  }

  // Heuristic 1: high-gas transactions (>3× avg) — MEV bots pay premium gas to frontrun
  const gasPrices = txs.map((tx) => parseInt(tx.gasPrice ?? "0", 16));
  const avgGas    = gasPrices.reduce((a, b) => a + b, 0) / gasPrices.length;
  const highGasTxs      = gasPrices.filter((g) => g > avgGas * 3).length;
  const highGasRatio    = highGasTxs / totalTxs;

  // Heuristic 2: repeated sender — sandwich bots send multiple consecutive txs
  const senderCounts: Record<string, number> = {};
  for (const tx of txs) senderCounts[tx.from] = (senderCounts[tx.from] ?? 0) + 1;
  const maxSenderTxs       = Math.max(...Object.values(senderCounts));
  const repeatedSenderRatio = maxSenderTxs / totalTxs;

  const riskScore = Math.min(100, Math.round((highGasRatio * 60 + repeatedSenderRatio * 40) * 100));
  const riskLevel =
    riskScore < 20 ? "low" :
    riskScore < 50 ? "medium" :
    riskScore < 80 ? "high" : "critical";

  return {
    source:                "base_rpc",
    risk_score:            riskScore,
    risk_level:            riskLevel,
    block_number:          parseInt((block?.number as string) ?? "0x0", 16),
    total_txs:             totalTxs,
    high_gas_txs:          highGasTxs,
    high_gas_ratio_pct:    Math.round(highGasRatio * 100),
    max_same_sender_txs:   maxSenderTxs,
    timestamp:             Date.now(),
  };
}

// ─── /gas-tracker ────────────────────────────────────────────────────────────

trading.get("/gas-tracker", async (c) => {
  const env = c.get("env");
  try {
    const data = await getOrFetch(
      env.REDIS_URL, "trading:gas-tracker",
      () => fetchGasPrices(env.BASE_RPC_URL),
      { ttlSeconds: 15 }
    );
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchGasPrices(baseRpcUrl: string) {
  const rpc = async (url: string, method: string, params: unknown[] = []) => {
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    return ((await r.json()) as { result: unknown }).result;
  };

  // ETH: try multiple public RPCs in sequence — llamarpc.com rate-limits server IPs
  const ETH_RPCS = [
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://rpc.ankr.com/eth",
  ];
  const tryEthRpc = async () => {
    for (const url of ETH_RPCS) {
      try { return await rpc(url, "eth_feeHistory", ["0x5", "latest", [10, 50, 90]]); } catch { /* next */ }
    }
    throw new Error("all ETH RPCs failed");
  };

  const [baseRes, ethRes, solRes] = await Promise.allSettled([
    rpc(baseRpcUrl,                            "eth_feeHistory", ["0x5", "latest", [10, 50, 90]]),
    tryEthRpc(),
    rpc("https://api.mainnet-beta.solana.com", "getRecentPrioritizationFees", []),
  ]);

  const parseEip1559 = (result: unknown) => {
    if (!result || typeof result !== "object") return null;
    const r = result as { baseFeePerGas?: string[]; reward?: string[][] };
    const baseFees = (r.baseFeePerGas ?? []).map(h => parseInt(h, 16));
    const rewards  = (r.reward ?? []).map(tier => tier.map(h => parseInt(h, 16)));
    const latestBase = baseFees[baseFees.length - 1] ?? 0;
    const slow       = latestBase + (rewards.at(-1)?.[0] ?? 0);
    const standard   = latestBase + (rewards.at(-1)?.[1] ?? 0);
    const fast       = latestBase + (rewards.at(-1)?.[2] ?? 0);
    return {
      slow:     parseFloat((slow     / 1e9).toFixed(4)),
      standard: parseFloat((standard / 1e9).toFixed(4)),
      fast:     parseFloat((fast     / 1e9).toFixed(4)),
      base_fee: parseFloat((latestBase / 1e9).toFixed(4)),
      unit:     "gwei",
    };
  };

  const parseSolana = (result: unknown) => {
    if (!Array.isArray(result) || result.length === 0) return null;
    const fees = result
      .map((r: { prioritizationFee?: number }) => r.prioritizationFee ?? 0)
      .sort((a, b) => a - b);
    return {
      low:    fees[Math.floor(fees.length * 0.1)] ?? 0,
      medium: fees[Math.floor(fees.length * 0.5)] ?? 0,
      high:   fees[Math.floor(fees.length * 0.9)] ?? 0,
      unit:   "microlamports",
    };
  };

  return {
    base:      baseRes.status === "fulfilled" ? parseEip1559(baseRes.value) : null,
    eth:       ethRes.status  === "fulfilled" ? parseEip1559(ethRes.value)  : null,
    solana:    solRes.status  === "fulfilled" ? parseSolana(solRes.value)   : null,
    timestamp: Date.now(),
  };
}

// ─── /token-screener ─────────────────────────────────────────────────────────

trading.get("/token-screener", async (c) => {
  const env      = c.get("env");
  const priceMin = Math.abs(Number(c.req.query("price_change_min") ?? 5));
  const volMin   = Math.abs(Number(c.req.query("volume_change_min") ?? 1_000_000));
  const limit    = Math.min(Math.max(1, Number(c.req.query("limit") ?? 20)), 50);
  const cacheKey = `trading:screener:${priceMin}:${volMin}:${limit}`;
  try {
    const data = await getOrFetch(
      env.REDIS_URL, cacheKey,
      () => fetchTokenScreener(priceMin, volMin, limit),
      { ttlSeconds: 60 }
    );
    return c.json({ success: true, bundle: "trading_engine", data });
  } catch {
    return c.json({ success: false, error: "upstream unavailable" }, 503);
  }
});

async function fetchTokenScreener(priceMin: number, volMin: number, limit: number) {
  // CoinGecko /coins/markets — free, no API key, returns 24h price change + volume
  // for all major tokens. Better fit than CCXT fetchTickers() which fetches all
  // exchange pairs and gets rate-limited from server IPs.
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&order=volume_desc&per_page=250&page=1" +
    "&price_change_percentage=24h&sparkline=false";

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`coingecko ${res.status}`);

  const coins = (await res.json()) as {
    symbol:                      string;
    name:                        string;
    current_price:               number;
    price_change_percentage_24h: number;
    total_volume:                number;
    high_24h:                    number;
    low_24h:                     number;
    market_cap:                  number;
  }[];

  const results = coins
    .filter(
      (c) =>
        Math.abs(c.price_change_percentage_24h ?? 0) >= priceMin &&
        (c.total_volume ?? 0) >= volMin
    )
    .sort(
      (a, b) =>
        Math.abs(b.price_change_percentage_24h) -
        Math.abs(a.price_change_percentage_24h)
    )
    .slice(0, limit)
    .map((c) => ({
      symbol:         c.symbol.toUpperCase() + "/USD",
      name:           c.name,
      price:          c.current_price,
      change_24h_pct: parseFloat((c.price_change_percentage_24h ?? 0).toFixed(2)),
      direction:      (c.price_change_percentage_24h ?? 0) >= 0 ? "up" : "down",
      volume_24h_usd: Math.round(c.total_volume ?? 0),
      high_24h:       c.high_24h,
      low_24h:        c.low_24h,
      market_cap:     c.market_cap,
    }));

  return {
    source:    "coingecko",
    screened:  results,
    count:     results.length,
    filters:   { price_change_min_pct: priceMin, volume_24h_min_usd: volMin },
    timestamp: Date.now(),
  };
}

export default trading;
