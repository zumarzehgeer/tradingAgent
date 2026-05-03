import "dotenv/config";
import { CONFIG } from "../config";
import { fetchCandles } from "./download";
import { runBacktest } from "./engine";
import { printReport } from "./report";
import { loadModelGate } from "../model";

// Default: 6 months ending now
const END_MS = Date.now();
const START_MS = END_MS - 1825 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const start = new Date(START_MS).toISOString().slice(0, 10);
  const end = new Date(END_MS).toISOString().slice(0, 10);
  console.log(`\nBacktest: ${CONFIG.pair} from ${start} to ${end}`);
  console.log(`Strategy: EMA${CONFIG.emaFast}/${CONFIG.emaSlow} + ATR${CONFIG.atrPeriod} + EMA${CONFIG.emaTrend}/${CONFIG.emaFastTrend}/${CONFIG.emaSlowTrend}(${CONFIG.trendInterval}) + mom ${(CONFIG.momentumConfirmPct * 100).toFixed(2)}% + cooldown ${CONFIG.cooldownCandles}`);
  console.log(`Risk: SL ${(CONFIG.stopLossPct * 100).toFixed(1)}%  TP ${(CONFIG.takeProfitPct * 100).toFixed(1)}%  DailyCap $${CONFIG.dailyLossCapUsdt}`);
  console.log();

  console.log("Downloading 1m candles...");
  const candles1m = await fetchCandles("BTCUSDT", "1m", START_MS, END_MS);

  console.log("Downloading 5m candles...");
  const candles5m = await fetchCandles("BTCUSDT", "5m", START_MS, END_MS);

  const modelGate = CONFIG.useModelGate
    ? await loadModelGate(CONFIG.modelPath, CONFIG.modelThreshold)
    : null;
  if (CONFIG.useModelGate) {
    console.log(modelGate ? `Model gate: P(win) >= ${modelGate.threshold}` : `Model gate enabled but ${CONFIG.modelPath} not found — running without gate`);
  }

  console.log(`\nRunning backtest on ${candles1m.length.toLocaleString()} × 1m candles...`);
  const start_ts = Date.now();

  const trades = runBacktest(candles1m, candles5m, {
    emaFast: CONFIG.emaFast,
    emaSlow: CONFIG.emaSlow,
    emaTrend: CONFIG.emaTrend,
    emaFastTrend: CONFIG.emaFastTrend,
    emaSlowTrend: CONFIG.emaSlowTrend,
    atrPeriod: CONFIG.atrPeriod,
    atrAveragingPeriod: CONFIG.atrAveragingPeriod,
    noTradeEma200BandPct: CONFIG.noTradeEma200BandPct,
    noTradeAtrMultiplier: CONFIG.noTradeAtrMultiplier,
    momentumConfirmPct: CONFIG.momentumConfirmPct,
    crossoverLookback: CONFIG.crossoverLookback,
    smartExitProfitPct: CONFIG.smartExitProfitPct,
    adxPeriod: CONFIG.adxPeriod,
    adxThreshold: CONFIG.adxThreshold,
    stopLossPct: CONFIG.stopLossPct,
    takeProfitPct: CONFIG.takeProfitPct,
    dailyLossCapUsdt: CONFIG.dailyLossCapUsdt,
    tradeSizeUsdt: CONFIG.tradeSizeUsdt,
    cooldownCandles: CONFIG.cooldownCandles,
    candleLookback: CONFIG.candleLookback,
    trendCandleLookback: CONFIG.trendCandleLookback,
    modelGate: modelGate ?? undefined,
  });

  const elapsed = ((Date.now() - start_ts) / 1000).toFixed(1);
  console.log(`Simulation complete in ${elapsed}s — ${trades.length} trades found`);

  printReport(trades, candles1m);
}

main().catch((err) => {
  console.error("Backtest failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
