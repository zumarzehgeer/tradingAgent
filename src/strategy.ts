import { EMA, RSI, ATR } from "technicalindicators";
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
    atr: number;
    atrAvg: number;
    emaTrend: number;
  };
}

export interface StrategyParams {
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  rsiPeriod: number;
  atrPeriod: number;
  atrAveragingPeriod: number;
  rsiBuyMin: number;
  rsiBuyMax: number;
  rsiSellMin: number;
  rsiSellMax: number;
  rsiEarlyExitLong: number;
  noTradeEma200BandPct: number;
  noTradeRsiMin: number;
  noTradeRsiMax: number;
  noTradeAtrMultiplier: number;
}

const ZERO_INDICATORS = {
  price: 0,
  emaFast: 0,
  emaSlow: 0,
  emaFastPrev: 0,
  emaSlowPrev: 0,
  rsi: 0,
  atr: 0,
  atrAvg: 0,
  emaTrend: 0,
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
  const rsiSeries = RSI.calculate({ period: params.rsiPeriod, values: closes });
  const atrSeries = ATR.calculate({ period: params.atrPeriod, high: highs, low: lows, close: closes });
  const emaTrendSeries = EMA.calculate({ period: params.emaTrend, values: closes5m });

  if (
    emaFastSeries.length < 2 ||
    emaSlowSeries.length < 2 ||
    rsiSeries.length < 1 ||
    atrSeries.length < params.atrAveragingPeriod ||
    emaTrendSeries.length < 1
  ) {
    return {
      action: "HOLD",
      reason: `indicator warmup incomplete (emaFast=${emaFastSeries.length}, emaSlow=${emaSlowSeries.length}, rsi=${rsiSeries.length}, atr=${atrSeries.length}, emaTrend=${emaTrendSeries.length})`,
      indicators: { ...ZERO_INDICATORS, price: closes[closes.length - 1] ?? 0 },
    };
  }

  const emaFast = emaFastSeries[emaFastSeries.length - 1];
  const emaFastPrev = emaFastSeries[emaFastSeries.length - 2];
  const emaSlow = emaSlowSeries[emaSlowSeries.length - 1];
  const emaSlowPrev = emaSlowSeries[emaSlowSeries.length - 2];
  const rsi = rsiSeries[rsiSeries.length - 1];
  const atr = atrSeries[atrSeries.length - 1];
  const atrAvg = mean(atrSeries.slice(-params.atrAveragingPeriod));
  const emaTrend = emaTrendSeries[emaTrendSeries.length - 1];
  const price = closes[closes.length - 1];

  const indicators = { price, emaFast, emaSlow, emaFastPrev, emaSlowPrev, rsi, atr, atrAvg, emaTrend };

  const bullishCross = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
  const bearishCross = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;

  if (position) {
    // RSI early exit takes priority — close before a bearish cross to lock in gains
    if (rsi > params.rsiEarlyExitLong) {
      return {
        action: "SELL",
        reason: `RSI early exit: rsi ${rsi.toFixed(1)} > ${params.rsiEarlyExitLong}`,
        indicators,
      };
    }

    if (bearishCross) {
      if (rsi < params.rsiSellMin || rsi > params.rsiSellMax) {
        return {
          action: "HOLD",
          reason: `bearish cross blocked: RSI ${rsi.toFixed(1)} outside sell window [${params.rsiSellMin}–${params.rsiSellMax}]`,
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
      reason: `position open, no exit signal (fast ${emaFast.toFixed(2)} vs slow ${emaSlow.toFixed(2)}, rsi ${rsi.toFixed(1)})`,
      indicators,
    };
  }

  // No-trade zone checks (entry only)
  const nearEma200Band = Math.abs(price - emaTrend) / emaTrend < params.noTradeEma200BandPct;
  if (nearEma200Band) {
    return {
      action: "HOLD",
      reason: `near EMA 200 band (price ${price.toFixed(2)} within ${(params.noTradeEma200BandPct * 100).toFixed(1)}% of trend ${emaTrend.toFixed(2)})`,
      indicators,
    };
  }

  const rsiNoMomentum = rsi >= params.noTradeRsiMin && rsi <= params.noTradeRsiMax;
  if (rsiNoMomentum) {
    return {
      action: "HOLD",
      reason: `RSI in no-momentum zone: ${rsi.toFixed(1)} in [${params.noTradeRsiMin}–${params.noTradeRsiMax}]`,
      indicators,
    };
  }

  const atrTooLow = atr < atrAvg * params.noTradeAtrMultiplier;
  if (atrTooLow) {
    return {
      action: "HOLD",
      reason: `ATR too low: ${atr.toFixed(2)} < ${(atrAvg * params.noTradeAtrMultiplier).toFixed(2)} (avg ${atrAvg.toFixed(2)} × ${params.noTradeAtrMultiplier})`,
      indicators,
    };
  }

  if (bullishCross) {
    if (price <= emaTrend) {
      return {
        action: "HOLD",
        reason: `bullish cross blocked: price ${price.toFixed(2)} below trend EMA ${emaTrend.toFixed(2)}`,
        indicators,
      };
    }
    if (rsi < params.rsiBuyMin || rsi > params.rsiBuyMax) {
      return {
        action: "HOLD",
        reason: `bullish cross blocked: RSI ${rsi.toFixed(1)} outside buy window [${params.rsiBuyMin}–${params.rsiBuyMax}]`,
        indicators,
      };
    }
    return {
      action: "BUY",
      reason: `bullish EMA cross (fast ${emaFast.toFixed(2)} > slow ${emaSlow.toFixed(2)}), rsi ${rsi.toFixed(1)}, trend ${emaTrend.toFixed(2)}, atr ${atr.toFixed(2)}`,
      indicators,
    };
  }

  return {
    action: "HOLD",
    reason: `no signal (fast ${emaFast.toFixed(2)} vs slow ${emaSlow.toFixed(2)}, rsi ${rsi.toFixed(1)})`,
    indicators,
  };
}
