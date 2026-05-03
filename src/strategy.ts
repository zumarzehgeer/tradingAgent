import { EMA, ATR, ADX } from "technicalindicators";
import { Candle } from "./binance";
import { OpenPosition } from "./state";

export type Action = "BUY" | "SELL" | "HOLD";

export interface Decision {
  action: Action;
  reason: string;
  indicators: {
    price: number;
    emaFast: number;
    emaSlow: number;
    emaFastPrev: number;
    emaSlowPrev: number;
    atr: number;
    atrAvg: number;
    emaTrend: number;
    emaFastTrend: number;
    emaSlowTrend: number;
    momentumPct: number;
  };
}

export interface StrategyParams {
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
  // Optional ADX trend-strength filter. 0 disables.
  adxPeriod?: number;
  adxThreshold?: number;
}

const ZERO_INDICATORS = {
  price: 0,
  emaFast: 0,
  emaSlow: 0,
  emaFastPrev: 0,
  emaSlowPrev: 0,
  atr: 0,
  atrAvg: 0,
  emaTrend: 0,
  emaFastTrend: 0,
  emaSlowTrend: 0,
  momentumPct: 0,
};

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function decide(
  candles1m: Candle[],
  candles5m: Candle[],
  position: OpenPosition | null,
  params: StrategyParams
): Decision {
  const closes = candles1m.map((c) => c.close);
  const highs = candles1m.map((c) => c.high);
  const lows = candles1m.map((c) => c.low);
  const closes5m = candles5m.map((c) => c.close);

  const minCandles1m = params.atrPeriod + params.atrAveragingPeriod + 2;
  if (closes.length < minCandles1m || closes.length < params.emaSlow + 2) {
    return {
      action: "HOLD",
      reason: `not enough 1m candles (have ${closes.length}, need ${Math.max(minCandles1m, params.emaSlow + 2)})`,
      indicators: { ...ZERO_INDICATORS, price: closes[closes.length - 1] ?? 0 },
    };
  }

  const emaFastSeries = EMA.calculate({ period: params.emaFast, values: closes });
  const emaSlowSeries = EMA.calculate({ period: params.emaSlow, values: closes });
  const atrSeries = ATR.calculate({ period: params.atrPeriod, high: highs, low: lows, close: closes });
  const emaTrendSeries = EMA.calculate({ period: params.emaTrend, values: closes5m });
  const emaFastTrendSeries = EMA.calculate({ period: params.emaFastTrend, values: closes5m });
  const emaSlowTrendSeries = EMA.calculate({ period: params.emaSlowTrend, values: closes5m });

  if (
    emaFastSeries.length < 2 ||
    emaSlowSeries.length < 2 ||
    atrSeries.length < params.atrAveragingPeriod ||
    emaTrendSeries.length < 1 ||
    emaFastTrendSeries.length < 1 ||
    emaSlowTrendSeries.length < 1
  ) {
    return {
      action: "HOLD",
      reason: `indicator warmup incomplete`,
      indicators: { ...ZERO_INDICATORS, price: closes[closes.length - 1] ?? 0 },
    };
  }

  const emaFast = emaFastSeries[emaFastSeries.length - 1];
  const emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
  const emaSlow = emaSlowSeries[emaSlowSeries.length - 1];
  const emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];
  const atr = atrSeries[atrSeries.length - 1];
  const atrAvg = mean(atrSeries.slice(-params.atrAveragingPeriod));
  const emaTrend = emaTrendSeries[emaTrendSeries.length - 1];
  const emaFastTrend = emaFastTrendSeries[emaFastTrendSeries.length - 1];
  const emaSlowTrend = emaSlowTrendSeries[emaSlowTrendSeries.length - 1];
  const price = closes[closes.length - 1];

  const bearishCross = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;

  // ── Exit logic ──────────────────────────────────────────────────────────────
  if (position) {
    const unrealizedPct = (price - position.entryPrice) / position.entryPrice;
    const indicators = {
      price, emaFast, emaSlow, emaFastPrev, emaSlowPrev,
      atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend,
      momentumPct: unrealizedPct * 100,
    };

    if (bearishCross) {
      if (unrealizedPct >= params.smartExitProfitPct) {
        return {
          action: "SELL",
          reason: `bearish EMA cross with +${(unrealizedPct * 100).toFixed(2)}% gain — locking in profit`,
          indicators,
        };
      }
      return {
        action: "HOLD",
        reason: `bearish cross but only ${(unrealizedPct * 100).toFixed(2)}% — holding for SL`,
        indicators,
      };
    }

    return {
      action: "HOLD",
      reason: `position open, no exit signal (fast ${emaFast.toFixed(2)} vs slow ${emaSlow.toFixed(2)}, ${(unrealizedPct * 100).toFixed(2)}%)`,
      indicators,
    };
  }

  // ── Entry logic ─────────────────────────────────────────────────────────────

  // No-trade: near EMA 200 band
  const nearEma200Band = Math.abs(price - emaTrend) / emaTrend < params.noTradeEma200BandPct;
  if (nearEma200Band) {
    return {
      action: "HOLD",
      reason: `near EMA 200 band (price ${price.toFixed(2)} within ${(params.noTradeEma200BandPct * 100).toFixed(2)}% of trend ${emaTrend.toFixed(2)})`,
      indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct: 0 },
    };
  }

  // No-trade: ADX below threshold (no clear trend)
  if (params.adxThreshold && params.adxThreshold > 0 && params.adxPeriod && params.adxPeriod > 0) {
    const adxSeries = ADX.calculate({
      period: params.adxPeriod,
      high: highs,
      low: lows,
      close: closes,
    });
    const adxVal = adxSeries.length > 0 ? adxSeries[adxSeries.length - 1].adx : 0;
    if (adxVal < params.adxThreshold) {
      return {
        action: "HOLD",
        reason: `ADX too low: ${adxVal.toFixed(2)} < ${params.adxThreshold}`,
        indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct: 0 },
      };
    }
  }

  // No-trade: ATR below average (dead market)
  if (atr < atrAvg * params.noTradeAtrMultiplier) {
    return {
      action: "HOLD",
      reason: `ATR too low: ${atr.toFixed(2)} < avg ${atrAvg.toFixed(2)} × ${params.noTradeAtrMultiplier}`,
      indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct: 0 },
    };
  }

  // No-trade: 5m EMA 9 not above 5m EMA 21 (higher-TF downtrend)
  if (emaFastTrend <= emaSlowTrend) {
    return {
      action: "HOLD",
      reason: `5m EMA alignment bearish: ema${params.emaFastTrend} ${emaFastTrend.toFixed(2)} <= ema${params.emaSlowTrend} ${emaSlowTrend.toFixed(2)}`,
      indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct: 0 },
    };
  }

  // No-trade: price below 5m EMA 200
  if (price <= emaTrend) {
    return {
      action: "HOLD",
      reason: `price ${price.toFixed(2)} below 5m trend EMA ${emaTrend.toFixed(2)}`,
      indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct: 0 },
    };
  }

  // Find the most recent bullish crossover within crossoverLookback candles.
  // Both EMA series are aligned at their tails (last element = latest candle).
  const maxLookback = Math.min(
    params.crossoverLookback,
    emaFastSeries.length - 2,
    emaSlowSeries.length - 2
  );
  let crossoverCloseIdx = -1;
  for (let d = 0; d <= maxLookback; d++) {
    const fCur = emaFastSeries[emaFastSeries.length - 1 - d];
    const sCur = emaSlowSeries[emaSlowSeries.length - 1 - d];
    const fPrev = emaFastSeries[emaFastSeries.length - 2 - d];
    const sPrev = emaSlowSeries[emaSlowSeries.length - 2 - d];

    if (fPrev <= sPrev && fCur > sCur) {
      // Bullish crossover happened d candles ago
      crossoverCloseIdx = closes.length - 1 - d;
      break;
    }
    // Stop looking back if EMA 9 is already below EMA 21 (bearish territory)
    if (d > 0 && fCur < sCur) break;
  }

  if (crossoverCloseIdx < 0) {
    return {
      action: "HOLD",
      reason: `no fresh bullish crossover within last ${params.crossoverLookback} candles`,
      indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct: 0 },
    };
  }

  const crossoverClose = closes[crossoverCloseIdx];
  const momentumThreshold = crossoverClose * (1 + params.momentumConfirmPct);
  const momentumPct = ((price - crossoverClose) / crossoverClose) * 100;

  if (price < momentumThreshold) {
    return {
      action: "HOLD",
      reason: `crossover found but momentum unconfirmed: price ${price.toFixed(2)} < threshold ${momentumThreshold.toFixed(2)} (${momentumPct.toFixed(3)}% of required ${(params.momentumConfirmPct * 100).toFixed(2)}%)`,
      indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct },
    };
  }

  return {
    action: "BUY",
    reason: `bullish cross confirmed: price ${price.toFixed(2)} +${momentumPct.toFixed(3)}% above crossover ${crossoverClose.toFixed(2)}, 5m ema${params.emaFastTrend} ${emaFastTrend.toFixed(2)} > ema${params.emaSlowTrend} ${emaSlowTrend.toFixed(2)}, atr ${atr.toFixed(2)}`,
    indicators: { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, atr, atrAvg, emaTrend, emaFastTrend, emaSlowTrend, momentumPct },
  };
}
