import { EMA, RSI } from "technicalindicators";
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
    rsi: number;
  };
}

export interface StrategyParams {
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
}

const ZERO_INDICATORS = {
  price: 0,
  emaFast: 0,
  emaSlow: 0,
  emaFastPrev: 0,
  emaSlowPrev: 0,
  rsi: 0,
};

export function decide(
  candles: Candle[],
  position: OpenPosition | null,
  params: StrategyParams
): Decision {
  const closes = candles.map((c) => c.close);

  if (closes.length < params.emaSlow + 2 || closes.length < params.rsiPeriod + 2) {
    return {
      action: "HOLD",
      reason: `not enough candles (have ${closes.length})`,
      indicators: { ...ZERO_INDICATORS, price: closes[closes.length - 1] ?? 0 },
    };
  }

  const emaFastSeries = EMA.calculate({ period: params.emaFast, values: closes });
  const emaSlowSeries = EMA.calculate({ period: params.emaSlow, values: closes });
  const rsiSeries = RSI.calculate({ period: params.rsiPeriod, values: closes });

  // technicalindicators warmup means series can be shorter than `closes`.
  // Guard explicitly: we need at least 2 EMA points (to detect a cross) and
  // 1 RSI point.
  if (emaFastSeries.length < 2 || emaSlowSeries.length < 2 || rsiSeries.length < 1) {
    return {
      action: "HOLD",
      reason: `indicator warmup incomplete (emaFast=${emaFastSeries.length}, emaSlow=${emaSlowSeries.length}, rsi=${rsiSeries.length})`,
      indicators: { ...ZERO_INDICATORS, price: closes[closes.length - 1] ?? 0 },
    };
  }

  const emaFast = emaFastSeries[emaFastSeries.length - 1];
  const emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
  const emaSlow = emaSlowSeries[emaSlowSeries.length - 1];
  const emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];
  const rsi = rsiSeries[rsiSeries.length - 1];
  const price = closes[closes.length - 1];

  const indicators = { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, rsi };

  const bullishCross = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
  const bearishCross = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;

  if (position) {
    if (bearishCross) {
      // Symmetric to the BUY filter: don't dump into oversold conditions
      // on a bearish cross. The hard SL in risk.ts still protects against
      // catastrophic downside; this just avoids selling the bottom on a
      // momentary cross during a panic wick.
      if (rsi <= params.rsiOversold) {
        return {
          action: "HOLD",
          reason: `bearish cross blocked by RSI ${rsi.toFixed(1)} <= ${params.rsiOversold} (oversold)`,
          indicators,
        };
      }
      return {
        action: "SELL",
        reason: `bearish EMA cross (fast ${emaFast.toFixed(2)} < slow ${emaSlow.toFixed(2)}, rsi ${rsi.toFixed(1)})`,
        indicators,
      };
    }
    return {
      action: "HOLD",
      reason: `position open, no bearish cross (fast ${emaFast.toFixed(2)} vs slow ${emaSlow.toFixed(2)}, rsi ${rsi.toFixed(1)})`,
      indicators,
    };
  }

  if (bullishCross && rsi < params.rsiOverbought) {
    return {
      action: "BUY",
      reason: `bullish EMA cross (fast ${emaFast.toFixed(2)} > slow ${emaSlow.toFixed(2)}), rsi ${rsi.toFixed(1)} < ${params.rsiOverbought}`,
      indicators,
    };
  }

  if (bullishCross) {
    return {
      action: "HOLD",
      reason: `bullish cross blocked by RSI ${rsi.toFixed(1)} >= ${params.rsiOverbought}`,
      indicators,
    };
  }

  return {
    action: "HOLD",
    reason: `no signal (fast ${emaFast.toFixed(2)} vs slow ${emaSlow.toFixed(2)}, rsi ${rsi.toFixed(1)})`,
    indicators,
  };
}
