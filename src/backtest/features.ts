import { ADX } from "technicalindicators";
import { Candle } from "../binance";
import { Decision } from "../strategy";

export interface TradeFeatures {
  atrPct: number;          // atr / entryPrice — volatility relative to price
  atrRatio: number;        // atr / atrAvg — volatility vs its own recent average
  adx: number;             // trend strength at entry
  momentumPct: number;     // % above the crossover close
  emaSpreadPct: number;    // (emaFast - emaSlow) / price
  distFromTrendPct: number;// (price - emaTrend) / emaTrend
  hourUtc: number;         // 0..23
  dayOfWeekUtc: number;    // 0=Sunday..6=Saturday
}

export const FEATURE_NAMES: (keyof TradeFeatures)[] = [
  "atrPct",
  "atrRatio",
  "adx",
  "momentumPct",
  "emaSpreadPct",
  "distFromTrendPct",
  "hourUtc",
  "dayOfWeekUtc",
];

export function extractFeatures(
  d: Decision,
  candle: Candle,
  window1m: Candle[],
  adxPeriod: number = 14
): TradeFeatures {
  const ind = d.indicators;
  const price = ind.price > 0 ? ind.price : candle.close;
  const atrAvgSafe = ind.atrAvg > 0 ? ind.atrAvg : 1;
  const trendSafe = ind.emaTrend > 0 ? ind.emaTrend : price;

  const adxSeries = ADX.calculate({
    period: adxPeriod,
    high: window1m.map((c) => c.high),
    low: window1m.map((c) => c.low),
    close: window1m.map((c) => c.close),
  });
  const adx = adxSeries.length > 0 ? adxSeries[adxSeries.length - 1].adx : 0;

  const ts = new Date(candle.openTime);

  return {
    atrPct: ind.atr / price,
    atrRatio: ind.atr / atrAvgSafe,
    adx,
    momentumPct: ind.momentumPct,
    emaSpreadPct: (ind.emaFast - ind.emaSlow) / price,
    distFromTrendPct: (price - trendSafe) / trendSafe,
    hourUtc: ts.getUTCHours(),
    dayOfWeekUtc: ts.getUTCDay(),
  };
}

export function featureVector(f: TradeFeatures): number[] {
  return FEATURE_NAMES.map((name) => f[name]);
}
