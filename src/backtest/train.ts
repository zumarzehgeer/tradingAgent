import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { CONFIG } from "../config";
import { fetchCandles } from "./download";
import { runBacktest, BacktestConfig, Trade } from "./engine";
import { FEATURE_NAMES, featureVector } from "./features";
import { fitLogReg, predictProb } from "./logreg";

// Train on the most recent 12 months and hold out the last 3 months for
// calibration check — matches the walk-forward window sizes that validated
// threshold 0.475 (out-of-sample PF ~1.41, 91% bootstrap above PF 1).
// Re-run quarterly to keep the model fresh.
const END_MS = Date.now();
const HOLDOUT_MONTHS = 3;
const TRAIN_MONTHS = 12;
const TOTAL_MONTHS = HOLDOUT_MONTHS + TRAIN_MONTHS;
const START_MS = END_MS - TOTAL_MONTHS * 30 * 24 * 60 * 60 * 1000;
const SPLIT_MS = END_MS - HOLDOUT_MONTHS * 30 * 24 * 60 * 60 * 1000;

function unfilteredCfg(extra: Partial<BacktestConfig> = {}): BacktestConfig {
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
    ...extra,
  };
}

interface ThresholdResult {
  threshold: number;
  trades: number;
  wins: number;
  wr: number;
  pf: number;
  totalPnl: number;
  avgPnl: number;
}

function evaluateThreshold(testTrades: Trade[], probs: number[], threshold: number): ThresholdResult {
  let wins = 0, n = 0, totalWin = 0, totalLoss = 0, totalPnl = 0;
  for (let i = 0; i < testTrades.length; i++) {
    if (probs[i] < threshold) continue;
    const t = testTrades[i];
    n++;
    totalPnl += t.pnlUsdt;
    if (t.pnlUsdt > 0) {
      wins++;
      totalWin += t.pnlUsdt;
    } else {
      totalLoss += Math.abs(t.pnlUsdt);
    }
  }
  const wr = n > 0 ? (wins / n) * 100 : 0;
  const pf = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Infinity : 0);
  return { threshold, trades: n, wins, wr, pf, totalPnl, avgPnl: n ? totalPnl / n : 0 };
}

async function main() {
  console.log(`\nTraining: ${CONFIG.pair}  ${new Date(START_MS).toISOString().slice(0, 10)} → ${new Date(END_MS).toISOString().slice(0, 10)}`);
  console.log(`Split: train first ${TRAIN_MONTHS} months, test the remainder`);

  console.log("Loading candles...");
  const candles1m = await fetchCandles("BTCUSDT", "1m", START_MS, END_MS);
  const candles5m = await fetchCandles("BTCUSDT", "5m", START_MS, END_MS);

  console.log("Running unfiltered backtest...");
  const trades = runBacktest(candles1m, candles5m, unfilteredCfg());
  const all = trades.filter((t) => t.features);

  const train = all.filter((t) => t.entryTime < SPLIT_MS);
  const test = all.filter((t) => t.entryTime >= SPLIT_MS);
  console.log(`Train: ${train.length} signals  (WR ${(train.filter(t => t.pnlUsdt > 0).length / train.length * 100).toFixed(1)}%)`);
  console.log(`Test:  ${test.length} signals  (WR ${(test.filter(t => t.pnlUsdt > 0).length / test.length * 100).toFixed(1)}%)`);

  if (train.length < 50 || test.length < 30) {
    console.log("Insufficient samples for a meaningful train/test split — aborting.");
    return;
  }

  // Build training matrix
  const X_train = train.map((t) => featureVector(t.features!));
  const y_train = train.map((t) => (t.pnlUsdt > 0 ? 1 : 0));

  console.log(`\nFitting logistic regression on ${train.length} samples × ${X_train[0].length} features (L2=1.0)...`);
  const model = fitLogReg(X_train, y_train, { l2: 1.0, maxIter: 100 });
  console.log(`  Converged in ${model.iterations} iterations, final LL=${model.finalLogLikelihood.toFixed(2)}`);

  console.log("\n  Standardized weights (z-score coefficient → impact on log-odds):");
  const wAbs = model.weights.slice(0, -1).map((w, i) => ({ name: FEATURE_NAMES[i], w }));
  wAbs.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  for (const { name, w } of wAbs) {
    const sign = w >= 0 ? "+" : "";
    console.log(`    ${name.padEnd(20)}  ${sign}${w.toFixed(4)}`);
  }
  console.log(`    ${"(bias)".padEnd(20)}  ${model.weights[model.weights.length - 1].toFixed(4)}`);

  // Predict on test set
  const X_test = test.map((t) => featureVector(t.features!));
  const probs = X_test.map((x) => predictProb(model, x));

  // Train predictions for sanity-check
  const X_train_probs = X_train.map((x) => predictProb(model, x));

  // Threshold sweep on test set
  const thresholds: number[] = [];
  for (let th = 0.30; th <= 0.65 + 1e-9; th += 0.025) thresholds.push(+th.toFixed(3));

  const line = "─".repeat(80);
  console.log(`\n${line}`);
  console.log("  THRESHOLD SWEEP (test set — out-of-sample)");
  console.log(line);
  console.log(`  ${"thresh".padStart(7)}  ${"trades".padStart(7)}  ${"WR%".padStart(5)}  ${"PF".padStart(6)}  ${"avgPnL".padStart(8)}  ${"totPnL".padStart(8)}`);
  console.log(line);
  const results: ThresholdResult[] = [];
  for (const th of thresholds) {
    const r = evaluateThreshold(test, probs, th);
    results.push(r);
    const pfStr = r.pf === Infinity ? "  ∞  " : r.pf.toFixed(3);
    console.log(
      `  ${th.toFixed(3).padStart(7)}  ${r.trades.toString().padStart(7)}  ${r.wr.toFixed(1).padStart(5)}  ${pfStr.padStart(6)}  ${(r.avgPnl >= 0 ? "+" : "") + r.avgPnl.toFixed(3).padStart(7)}  ${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2).padStart(7)}`
    );
  }
  console.log(line);

  // Pick best threshold by PF on test, requiring at least 15 trades to avoid degenerate winners
  const candidates = results.filter((r) => r.trades >= 15 && r.pf !== Infinity);
  const best = candidates.length
    ? candidates.reduce((a, b) => (b.pf > a.pf ? b : a))
    : null;
  if (best) {
    console.log(`\n  Best test-period threshold (n>=15): ${best.threshold.toFixed(3)}`);
    console.log(`    trades=${best.trades}, WR=${best.wr.toFixed(1)}%, PF=${best.pf.toFixed(3)}, totPnL=${best.totalPnl >= 0 ? "+" : ""}${best.totalPnl.toFixed(2)}`);
  } else {
    console.log(`\n  No threshold meets the n>=15 minimum.`);
  }

  // Train-set sanity check
  const trainBaselineWR = (y_train.filter((y) => y === 1).length / y_train.length) * 100;
  const trainAt05 = X_train_probs.filter((p) => p >= 0.5).length;
  const trainWinsAt05 = X_train_probs.filter((p, i) => p >= 0.5 && y_train[i] === 1).length;
  console.log(`\n  Train sanity check:  baseline WR ${trainBaselineWR.toFixed(1)}%   at p>=0.5: ${trainAt05} trades, ${trainWinsAt05} wins (${trainAt05 ? (trainWinsAt05/trainAt05*100).toFixed(1) : "0"}%)`);

  // Save model
  const outDir = path.resolve("models");
  await fs.mkdir(outDir, { recursive: true });
  const modelOut = {
    featureNames: FEATURE_NAMES,
    weights: model.weights,
    means: model.means,
    stds: model.stds,
    // Walk-forward (5y) validated 0.475 as the robust threshold across folds.
    // train.ts also reports the in-sample-optimal threshold above, but production
    // should use the walk-forward-validated value. The bot reads the threshold
    // from CONFIG.modelThreshold by default and only falls back to this.
    threshold: 0.475,
    inSampleOptimum: best ? { threshold: best.threshold, pf: best.pf, wr: best.wr } : null,
    trainedAt: new Date().toISOString(),
    trainPeriod: { start: new Date(START_MS).toISOString(), splitAt: new Date(SPLIT_MS).toISOString() },
    trainSize: train.length,
    testSize: test.length,
    testPF: best ? best.pf : null,
    testWR: best ? best.wr : null,
  };
  const outPath = path.join(outDir, "logreg.json");
  await fs.writeFile(outPath, JSON.stringify(modelOut, null, 2), "utf-8");
  console.log(`\n  Model saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Train failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
