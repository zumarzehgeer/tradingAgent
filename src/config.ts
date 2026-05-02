import "dotenv/config";

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const CONFIG = {
  pair: "BTCUSDT",
  baseAsset: "BTC",
  quoteAsset: "USDT",

  tradeSizeUsdt: 10,

  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  rsiOverbought: 70,

  stopLossPct: 0.01,
  takeProfitPct: 0.02,

  dailyLossCapUsdt: 5,

  pollIntervalMs: 60_000,
  candleInterval: "1m" as const,
  candleLookback: 101,

  testnet: process.env.BINANCE_TESTNET !== "false",
  ignoreOrphanBtc: process.env.BINANCE_IGNORE_ORPHAN_BTC === "true",

  apiKey: requireEnv("BINANCE_API_KEY"),
  apiSecret: requireEnv("BINANCE_API_SECRET"),

  stateFile: "state.json",
} as const;

export type AppConfig = typeof CONFIG;
