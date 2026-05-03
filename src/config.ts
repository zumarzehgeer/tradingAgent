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

  // 5m trend filter — EMA 200 direction + EMA 9/21 alignment
  emaTrend: 200,
  emaFastTrend: 9,
  emaSlowTrend: 21,
  trendInterval: "5m" as const,
  trendCandleLookback: 220,

  // v3: ATR volatility filter (ATR must be ABOVE its average to trade)
  // Disabled (set to 0) because the logistic-regression model gate is the
  // primary filter and was trained on unfiltered signals. Re-enabling this
  // would change the distribution the model sees and invalidate its calibration.
  // 5y test invalidated the prior atr=1.5 + adx=25 hand-tune (PF 0.823, -$5.40).
  atrPeriod: 14,
  atrAveragingPeriod: 14,
  noTradeAtrMultiplier: 0,

  // ADX still computed (used as a feature for the model) but not used as a
  // hard gate. Same reason as above.
  adxPeriod: 14,
  adxThreshold: 0,

  // v3: no-trade band around EMA 200 (tightened to ±0.1%)
  noTradeEma200BandPct: 0.001,

  // v3: momentum confirmation — price must move +0.15% above crossover close
  momentumConfirmPct: 0.0015,
  crossoverLookback: 10,

  // v3: smart signal exit — only exit on bearish cross if already at this profit
  // Set to 0.99 to effectively disable signal exits and rely on SL/TP only
  smartExitProfitPct: 0.99,

  // v3: post-trade cooldown (increased to 10 candles)
  cooldownCandles: 10,

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

  // Logistic-regression gate. Bot skips BUY unless model's P(win) >= threshold.
  // 5y walk-forward validated 0.475 (out-of-sample WR ~48.5%, PF ~1.41,
  // 91% bootstrap iterations above PF 1, ~15 trades/year expected).
  // Retrain quarterly: `npm run train` (uses last 12mo, writes models/logreg.json).
  useModelGate: true,
  modelPath: "models/logreg.json",
  modelThreshold: 0.475,

  // Tick-error circuit breaker. After this many consecutive failed ticks,
  // the bot stops rather than retrying forever.
  maxConsecutiveTickErrors: 10,
} as const;

export type AppConfig = typeof CONFIG;
