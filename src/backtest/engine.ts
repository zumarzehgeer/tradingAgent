import { Candle } from "../binance";
import { decide, StrategyParams } from "../strategy";
import { checkRisk, RiskParams } from "../risk";
import { extractFeatures, TradeFeatures, featureVector } from "./features";

export interface Trade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qtyBtc: number;
  pnlUsdt: number;
  exitReason: "SL" | "TP" | "signal" | "early-exit" | "risk";
  features?: TradeFeatures;
}

export interface ModelGate {
  weights: number[];        // length = features + 1 (last is bias)
  means: number[];          // per-feature mean for z-score
  stds: number[];           // per-feature std for z-score
  threshold: number;        // skip BUY if sigmoid(z·w + b) < threshold
}

export interface BacktestConfig {
  // Strategy
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  emaFastTrend: number;
  emaSlowTrend: number;
  atrPeriod: number;
  atrAveragingPeriod: number;
  noTradeEma200BandPct: number;
  noTradeAtrMultiplier: number;
  momentumConfirmPct: number;
  crossoverLookback: number;
  smartExitProfitPct: number;
  // Optional ADX filter
  adxPeriod?: number;
  adxThreshold?: number;
  // Optional hour-of-day filter (UTC hours 0-23). If set, only enter during these hours.
  allowedHoursUtc?: number[];
  // Optional logistic regression gate: skip BUY if model P(win) < threshold
  modelGate?: ModelGate;
  // When true, the engine attaches per-trade entry features to each Trade.
  recordFeatures?: boolean;
  // Risk
  stopLossPct: number;
  takeProfitPct: number;
  dailyLossCapUsdt: number;
  // Optional: ATR-based exits (override fixed pct when set)
  slAtrMult?: number;
  tpAtrMult?: number;
  // Sizing
  tradeSizeUsdt: number;
  cooldownCandles: number;
  // Windows
  candleLookback: number;       // 1m window size (e.g. 101)
  trendCandleLookback: number;  // 5m window size (e.g. 220)
}

interface SimPosition {
  entryPrice: number;
  qtyBtc: number;
  entryTime: number;
  entryFeeUsdt: number;
  slPrice: number;
  tpPrice: number;
  features?: TradeFeatures;
}

interface SimState {
  position: SimPosition | null;
  dayUtc: string;
  dailyRealizedPnlUsdt: number;
  dailyTradeCount: number;
  cooldownCandlesRemaining: number;
}

const FEE_RATE = 0.001; // 0.1% taker

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function closeTrade(
  state: SimState,
  exitPrice: number,
  exitTime: number,
  exitReason: Trade["exitReason"],
  cooldownCandles: number,
  trades: Trade[]
): SimState {
  const pos = state.position!;
  const exitNotional = exitPrice * pos.qtyBtc;
  const exitFee = exitNotional * FEE_RATE;
  const grossPnl = (exitPrice - pos.entryPrice) * pos.qtyBtc;
  const pnlUsdt = grossPnl - pos.entryFeeUsdt - exitFee;

  trades.push({
    entryTime: pos.entryTime,
    exitTime,
    entryPrice: pos.entryPrice,
    exitPrice,
    qtyBtc: pos.qtyBtc,
    pnlUsdt,
    exitReason,
    features: pos.features,
  });

  return {
    ...state,
    position: null,
    dailyRealizedPnlUsdt: state.dailyRealizedPnlUsdt + pnlUsdt,
    dailyTradeCount: state.dailyTradeCount + 1,
    cooldownCandlesRemaining: cooldownCandles,
  };
}

// Find the highest 5m candle index whose closeTime <= targetCloseTime.
// Returns -1 if none.
function find5mBoundary(candles5m: Candle[], targetCloseTime: number, hint: number): number {
  let idx = hint;
  while (idx + 1 < candles5m.length && candles5m[idx + 1].closeTime <= targetCloseTime) {
    idx++;
  }
  return idx;
}

export function runBacktest(
  candles1m: Candle[],
  candles5m: Candle[],
  cfg: BacktestConfig
): Trade[] {
  const trades: Trade[] = [];
  const stratParams: StrategyParams = {
    emaFast: cfg.emaFast,
    emaSlow: cfg.emaSlow,
    emaTrend: cfg.emaTrend,
    emaFastTrend: cfg.emaFastTrend,
    emaSlowTrend: cfg.emaSlowTrend,
    atrPeriod: cfg.atrPeriod,
    atrAveragingPeriod: cfg.atrAveragingPeriod,
    noTradeEma200BandPct: cfg.noTradeEma200BandPct,
    noTradeAtrMultiplier: cfg.noTradeAtrMultiplier,
    momentumConfirmPct: cfg.momentumConfirmPct,
    crossoverLookback: cfg.crossoverLookback,
    smartExitProfitPct: cfg.smartExitProfitPct,
    adxPeriod: cfg.adxPeriod,
    adxThreshold: cfg.adxThreshold,
  };
  const riskParams: RiskParams = {
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct,
    dailyLossCapUsdt: cfg.dailyLossCapUsdt,
  };

  let state: SimState = {
    position: null,
    dayUtc: candles1m.length > 0 ? utcDate(candles1m[0].openTime) : "",
    dailyRealizedPnlUsdt: 0,
    dailyTradeCount: 0,
    cooldownCandlesRemaining: 0,
  };

  // 5m boundary pointer — advances monotonically, never resets
  let idx5m = -1;

  for (let i = 0; i < candles1m.length; i++) {
    const candle = candles1m[i];

    // Daily rollover
    const day = utcDate(candle.openTime);
    if (day !== state.dayUtc) {
      state = { ...state, dayUtc: day, dailyRealizedPnlUsdt: 0, dailyTradeCount: 0 };
    }

    // Advance 5m pointer to latest candle whose closeTime <= current 1m candle's closeTime
    idx5m = find5mBoundary(candles5m, candle.closeTime, Math.max(0, idx5m));

    // Build sliding windows
    const start1m = Math.max(0, i - cfg.candleLookback + 1);
    const window1m = candles1m.slice(start1m, i + 1);

    const start5m = Math.max(0, idx5m - cfg.trendCandleLookback + 1);
    const window5m = idx5m >= 0 ? candles5m.slice(start5m, idx5m + 1) : [];

    // Cooldown: decrement only when no position is open (mirrors live logic)
    const cooldownRemaining = state.cooldownCandlesRemaining;
    const isCoolingDown = !state.position && cooldownRemaining > 0;
    if (isCoolingDown) {
      state = { ...state, cooldownCandlesRemaining: cooldownRemaining - 1 };
    }

    // ── Intrabar SL/TP check ──────────────────────────────────────────────
    if (state.position) {
      const { slPrice, tpPrice } = state.position;
      const slHit = candle.low <= slPrice;
      const tpHit = candle.high >= tpPrice;

      if (slHit || tpHit) {
        // If both hit on the same candle, assume SL (worst case)
        const exitPrice = slHit ? slPrice : tpPrice;
        const reason: Trade["exitReason"] = slHit ? "SL" : "TP";
        state = closeTrade(state, exitPrice, candle.closeTime, reason, cfg.cooldownCandles, trades);
        continue; // skip close-price logic for this candle
      }
    }

    // ── Close-price logic ─────────────────────────────────────────────────

    // checkRisk uses a simplified state shape; pass what it needs
    const riskState = {
      position: state.position
        ? {
            entryPrice: state.position.entryPrice,
            qtyBtc: state.position.qtyBtc,
            entryTimestamp: state.position.entryTime,
            entryCommissionUsdt: state.position.entryFeeUsdt,
          }
        : null,
      dayUtc: state.dayUtc,
      dailyRealizedPnlUsdt: state.dailyRealizedPnlUsdt,
      dailyTradeCount: state.dailyTradeCount,
      cooldownCandlesRemaining: state.cooldownCandlesRemaining,
    };

    const risk = checkRisk(riskState, candle.close, riskParams);

    if (risk.action === "FORCE_SELL" && state.position) {
      state = closeTrade(state, candle.close, candle.closeTime, "risk", cfg.cooldownCandles, trades);
      continue;
    }

    const d = decide(window1m, window5m, riskState.position, stratParams);

    if (d.action === "SELL" && state.position) {
      const reason: Trade["exitReason"] =
        d.reason.startsWith("RSI early exit") ? "early-exit" : "signal";
      state = closeTrade(state, candle.close, candle.closeTime, reason, cfg.cooldownCandles, trades);
    } else if (d.action === "BUY" && !state.position && !isCoolingDown && risk.action !== "BLOCK_BUYS" && (!cfg.allowedHoursUtc || cfg.allowedHoursUtc.includes(new Date(candle.openTime).getUTCHours()))) {
      // Compute entry features once — used for recording and (optionally) the model gate.
      const features =
        cfg.recordFeatures || cfg.modelGate
          ? extractFeatures(d, candle, window1m, cfg.adxPeriod ?? 14)
          : undefined;

      // Optional model gate
      if (cfg.modelGate && features) {
        const vec = featureVector(features);
        const { weights, means, stds, threshold } = cfg.modelGate;
        let z = weights[weights.length - 1]; // bias
        for (let k = 0; k < vec.length; k++) {
          const stdSafe = stds[k] || 1;
          z += weights[k] * ((vec[k] - means[k]) / stdSafe);
        }
        const pWin = 1 / (1 + Math.exp(-z));
        if (pWin < threshold) continue;
      }

      const entryFeeUsdt = cfg.tradeSizeUsdt * FEE_RATE;
      const entryPrice = candle.close;
      const qtyBtc = (cfg.tradeSizeUsdt - entryFeeUsdt) / entryPrice;
      const atr = d.indicators.atr;
      const slPrice =
        cfg.slAtrMult && atr > 0
          ? entryPrice - cfg.slAtrMult * atr
          : entryPrice * (1 - cfg.stopLossPct);
      const tpPrice =
        cfg.tpAtrMult && atr > 0
          ? entryPrice + cfg.tpAtrMult * atr
          : entryPrice * (1 + cfg.takeProfitPct);
      state = {
        ...state,
        position: {
          entryPrice,
          qtyBtc,
          entryTime: candle.closeTime,
          entryFeeUsdt,
          slPrice,
          tpPrice,
          features,
        },
      };
    }
  }

  // Force-close any open position at last candle (end of backtest period)
  if (state.position && candles1m.length > 0) {
    const last = candles1m[candles1m.length - 1];
    state = closeTrade(state, last.close, last.closeTime, "signal", 0, trades);
  }

  return trades;
}
