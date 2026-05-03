import "dotenv/config";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Live mode requires explicit BINANCE_LIVE=true. Anything else (missing,
// "false", "0", typos) keeps the bot on testnet. This is intentional: the
// safest default must require an unambiguous opt-in to risk real funds.
const live = process.env.BINANCE_LIVE === "true";

export const CONFIG = {
  pair: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",

  tradeSizeUsdt: 10,

  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,

  // v2: 5m trend filter
  emaTrend: 200,
  trendInterval: "5m" as const,
  trendCandleLookback: 220,

  // v2: tighter RSI entry windows (replaces rsiOverbought/rsiOversold)
  rsiBuyMin: 40,
  rsiBuyMax: 65,
  rsiSellMin: 35,
  rsiSellMax: 60,

  // v2: early exit — RSI flip threshold (for longs).
  // Intentional 5-point gap vs rsiBuyMax (65): RSI 65–70 while in a trade is
  // unguarded by the early-exit path; only a bearish EMA cross or hard SL/TP
  // exits in that range. This avoids hair-trigger exits on normal post-entry
  // RSI drift and only fires on genuine overbought spikes.
  rsiEarlyExitLong: 70,

  // v2: ATR volatility filter
  atrPeriod: 14,
  atrAveragingPeriod: 14,

  // v2: no-trade zones
  noTradeEma200BandPct: 0.005,
  noTradeRsiMin: 45,
  noTradeRsiMax: 55,
  noTradeAtrMultiplier: 0.8,

  // v2: post-trade cooldown (candles to wait after a trade closes)
  cooldownCandles: 3,

  stopLossPct: 0.01,
  takeProfitPct: 0.02,

  dailyLossCapUsdt: 5,

  pollIntervalMs: 60_000,
  candleInterval: "1m" as const,
  candleLookback: 101,

  testnet: !live,
  ignoreOrphanBtc: process.env.BINANCE_IGNORE_ORPHAN_BTC === "true",

  apiKey: requireEnv("BINANCE_API_KEY"),
  apiSecret: requireEnv("BINANCE_API_SECRET"),

  stateFile: "state.json",

  // Halt the bot if a position is older than this. SL/TP computed from a
  // stale entry price are not safe to act on automatically.
  maxPositionAgeHours: 24,

  // Tick-error circuit breaker. After this many consecutive failed ticks,
  // the bot stops rather than retrying forever.
  maxConsecutiveTickErrors: 10,
} as const;

export type AppConfig = typeof CONFIG;
