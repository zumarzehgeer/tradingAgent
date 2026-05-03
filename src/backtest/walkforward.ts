import "dotenv/config";
import { CONFIG } from "../config";
import { fetchCandles } from "./download";
import { runBacktest, BacktestConfig, Trade } from "./engine";
import { FEATURE_NAMES, featureVector } from "./features";
import { fitLogReg, predictProb } from "./logreg";

const END_MS = Date.now();
const START_MS = END_MS - 1825 * 24 * 60 * 60 * 1000;

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
// 12-month train / 3-month test, stepped 3 months — gives ~16 folds over 5 years
// with substantial samples per fold (typically 200-400 train, 50-100 test).
const TRAIN_WINDOW_MS = 12 * MONTH_MS;
const TEST_WINDOW_MS = 3 * MONTH_MS;
const STEP_MS = 3 * MONTH_MS;

const THRESHOLDS = [0.40, 0.425, 0.45, 0.475, 0.50];
const BOOTSTRAP_N = 10000;

function unfilteredCfg(): BacktestConfig {
  return {
    emaFast: CONFIG.emaFast,
    emaSlow: CONFIG.emaSlow,
    emaTrend: CONFIG.emaTrend,
    emaFastTrend: CONFIG.emaFastTrend,
    emaSlowTrend: CONFIG.emaSlowTrend,
    atrPeriod: CONFIG.atrPeriod,
    atrAveragingPeriod: CONFIG.atrAveragingPeriod,
    noTradeEma200BandPct: CONFIG.noTradeEma200BandPct,
    noTradeAtrMultiplier: 0,
    momentumConfirmPct: CONFIG.momentumConfirmPct,
    crossoverLookback: CONFIG.crossoverLookback,
    smartExitProfitPct: CONFIG.smartExitProfitPct,
    adxPeriod: 14,
    adxThreshold: 0,
    stopLossPct: CONFIG.stopLossPct,
    takeProfitPct: CONFIG.takeProfitPct,
    dailyLossCapUsdt: CONFIG.dailyLossCapUsdt,
    tradeSizeUsdt: CONFIG.tradeSizeUsdt,
    cooldownCandles: CONFIG.cooldownCandles,
    candleLookback: CONFIG.candleLookback,
    trendCandleLookback: CONFIG.trendCandleLookback,
    recordFeatures: true,
  };
}

function summarize(trades: Trade[]): { n: number; wins: number; wr: number; pf: number; pnl: number } {
  if (trades.length === 0) return { n: 0, wins: 0, wr: 0, pf: 0, pnl: 0 };
  let wins = 0, gWin = 0, gLoss = 0, pnl = 0;
  for (const t of trades) {
    pnl += t.pnlUsdt;
    if (t.pnlUsdt > 0) {
      wins++;
      gWin += t.pnlUsdt;
    } else {
      gLoss += Math.abs(t.pnlUsdt);
    }
  }
  return {
    n: trades.length,
    wins,
    wr: (wins / trades.length) * 100,
    pf: gLoss > 0 ? gWin / gLoss : (gWin > 0 ? Infinity : 0),
    pnl,
  };
}

function bootstrapPF(trades: Trade[], iters: number): { p5: number; p50: number; p95: number; pPositive: number } {
  if (trades.length === 0) return { p5: 0, p50: 0, p95: 0, pPositive: 0 };
  const pfs: number[] = [];
  let positive = 0;
  for (let s = 0; s < iters; s++) {
    let gWin = 0, gLoss = 0;
    for (let i = 0; i < trades.length; i++) {
      const t = trades[Math.floor(Math.random() * trades.length)];
      if (t.pnlUsdt > 0) gWin += t.pnlUsdt;
      else gLoss += Math.abs(t.pnlUsdt);
    }
    const pf = gLoss > 0 ? gWin / gLoss : (gWin > 0 ? 1000 : 0);
    pfs.push(pf);
    if (pf > 1) positive++;
  }
  pfs.sort((a, b) => a - b);
  return {
    p5: pfs[Math.floor(0.05 * pfs.length)],
    p50: pfs[Math.floor(0.5 * pfs.length)],
    p95: pfs[Math.floor(0.95 * pfs.length)],
    pPositive: positive / iters,
  };
}

async function main() {
  console.log(`\nWalk-forward: ${CONFIG.pair}  ${new Date(START_MS).toISOString().slice(0, 10)} → ${new Date(END_MS).toISOString().slice(0, 10)}`);
  console.log(`Train window: ${TRAIN_WINDOW_MS / MONTH_MS}m   Test window: ${TEST_WINDOW_MS / MONTH_MS}m   Step: ${STEP_MS / MONTH_MS}m`);

  console.log("Loading candles...");
  const candles1m = await fetchCandles("BTCUSDT", "1m", START_MS, END_MS);
  const candles5m = await fetchCandles("BTCUSDT", "5m", START_MS, END_MS);

  console.log("Running unfiltered backtest to collect all signals...");
  const allTrades = runBacktest(candles1m, candles5m, unfilteredCfg()).filter((t) => t.features);
  console.log(`Total signals: ${allTrades.length}\n`);

  const line = "─".repeat(110);
  console.log(line);
  console.log("  WALK-FORWARD FOLDS");
  console.log(line);
  console.log(`  ${"fold".padEnd(28)}  ${"trainN".padStart(7)}  ${"testN".padStart(6)}  ${"thr".padStart(5)}  ${"keptN".padStart(6)}  ${"WR%".padStart(5)}  ${"PF".padStart(6)}  ${"PnL$".padStart(7)}`);
  console.log(line);

  // Per-threshold collected test trades across all folds (concatenated, out-of-sample)
  const concatenated: Record<number, Trade[]> = {};
  for (const th of THRESHOLDS) concatenated[th] = [];

  let foldStart = START_MS;
  let foldNum = 0;
  while (foldStart + TRAIN_WINDOW_MS + TEST_WINDOW_MS <= END_MS) {
    const trainStart = foldStart;
    const trainEnd = foldStart + TRAIN_WINDOW_MS;
    const testEnd = trainEnd + TEST_WINDOW_MS;

    const train = allTrades.filter((t) => t.entryTime >= trainStart && t.entryTime < trainEnd);
    const test = allTrades.filter((t) => t.entryTime >= trainEnd && t.entryTime < testEnd);

    if (train.length < 30 || test.length < 5) {
      foldStart += STEP_MS;
      continue;
    }

    const X_train = train.map((t) => featureVector(t.features!));
    const y_train = train.map((t) => (t.pnlUsdt > 0 ? 1 : 0));
    let model;
    try {
      model = fitLogReg(X_train, y_train, { l2: 1.0, maxIter: 50 });
    } catch {
      foldStart += STEP_MS;
      continue;
    }

    const X_test = test.map((t) => featureVector(t.features!));
    const probs = X_test.map((x) => predictProb(model, x));

    const foldLabel = `${new Date(trainStart).toISOString().slice(0, 7)}→${new Date(trainEnd).toISOString().slice(0, 7)}/${new Date(testEnd).toISOString().slice(0, 7)}`;

    for (const th of THRESHOLDS) {
      const kept: Trade[] = [];
      for (let i = 0; i < test.length; i++) {
        if (probs[i] >= th) kept.push(test[i]);
      }
      const s = summarize(kept);
      concatenated[th].push(...kept);
      const pfStr = s.pf === Infinity ? "  ∞  " : s.pf.toFixed(3);
      console.log(
        `  ${foldLabel.padEnd(28)}  ${train.length.toString().padStart(7)}  ${test.length.toString().padStart(6)}  ${th.toFixed(3).padStart(5)}  ${s.n.toString().padStart(6)}  ${s.wr.toFixed(1).padStart(5)}  ${pfStr.padStart(6)}  ${(s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2).padStart(6)}`
      );
    }
    console.log();

    foldStart += STEP_MS;
    foldNum++;
  }

  console.log(line);
  console.log("  AGGREGATED OUT-OF-SAMPLE (concatenate test slices across folds, per threshold)");
  console.log(line);
  console.log(`  ${"thresh".padStart(7)}  ${"trades".padStart(7)}  ${"WR%".padStart(5)}  ${"PF".padStart(6)}  ${"totPnL".padStart(8)}  ${"bs5".padStart(6)}  ${"bs50".padStart(6)}  ${"bs95".padStart(6)}  ${"P(PF>1)".padStart(8)}`);
  console.log(line);
  for (const th of THRESHOLDS) {
    const trades = concatenated[th];
    const s = summarize(trades);
    const bs = bootstrapPF(trades, BOOTSTRAP_N);
    const pfStr = s.pf === Infinity ? "  ∞  " : s.pf.toFixed(3);
    console.log(
      `  ${th.toFixed(3).padStart(7)}  ${s.n.toString().padStart(7)}  ${s.wr.toFixed(1).padStart(5)}  ${pfStr.padStart(6)}  ${(s.pnl >= 0 ? "+" : "") + s.pnl.toFixed(2).padStart(7)}  ${bs.p5.toFixed(2).padStart(6)}  ${bs.p50.toFixed(2).padStart(6)}  ${bs.p95.toFixed(2).padStart(6)}  ${(bs.pPositive * 100).toFixed(1).padStart(7)}%`
    );
  }
  console.log(line);

  // Decision rule from the plan
  console.log(`\n  Decision rule: median PF > 1.15 AND bootstrap 5th-percentile PF > 1.0 → keep model`);
  for (const th of THRESHOLDS) {
    const trades = concatenated[th];
    if (trades.length < 20) continue;
    const s = summarize(trades);
    const bs = bootstrapPF(trades, BOOTSTRAP_N);
    const pass = bs.p50 > 1.15 && bs.p5 > 1.0;
    console.log(
      `    threshold=${th.toFixed(3)}  n=${trades.length}  median PF=${bs.p50.toFixed(2)}  p5 PF=${bs.p5.toFixed(2)}  ${pass ? "✓ PASS" : "✗ fail"}`
    );
  }
}

main().catch((err) => {
  console.error("Walkforward failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
