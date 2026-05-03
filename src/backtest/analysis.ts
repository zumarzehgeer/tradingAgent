import "dotenv/config";
import { CONFIG } from "../config";
import { fetchCandles } from "./download";
import { runBacktest, BacktestConfig, Trade } from "./engine";
import { FEATURE_NAMES, TradeFeatures } from "./features";

const END_MS = Date.now();
const START_MS = END_MS - 1825 * 24 * 60 * 60 * 1000;

const QUANTILES = [0, 0.25, 0.5, 0.75, 1.0];

function quantileEdges(values: number[], qs: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  return qs.map((q) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    return sorted[idx];
  });
}

function bucketIndex(value: number, edges: number[]): number {
  // edges has 5 entries; bucket count = 4. Use upper edges except last.
  for (let i = 1; i < edges.length - 1; i++) {
    if (value <= edges[i]) return i - 1;
  }
  return edges.length - 2;
}

function fmtPnl(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(2);
}

interface BucketStats {
  n: number;
  wins: number;
  totalPnl: number;
}

function newBucket(): BucketStats {
  return { n: 0, wins: 0, totalPnl: 0 };
}

function single(trades: Trade[], feature: keyof TradeFeatures, edges: number[]): BucketStats[] {
  const buckets: BucketStats[] = [newBucket(), newBucket(), newBucket(), newBucket()];
  for (const t of trades) {
    if (!t.features) continue;
    const v = t.features[feature];
    const b = bucketIndex(v, edges);
    buckets[b].n++;
    if (t.pnlUsdt > 0) buckets[b].wins++;
    buckets[b].totalPnl += t.pnlUsdt;
  }
  return buckets;
}

function pair(trades: Trade[], a: keyof TradeFeatures, aEdges: number[], b: keyof TradeFeatures, bEdges: number[]): BucketStats[][] {
  const grid: BucketStats[][] = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => newBucket())
  );
  for (const t of trades) {
    if (!t.features) continue;
    const ai = bucketIndex(t.features[a], aEdges);
    const bi = bucketIndex(t.features[b], bEdges);
    grid[ai][bi].n++;
    if (t.pnlUsdt > 0) grid[ai][bi].wins++;
    grid[ai][bi].totalPnl += t.pnlUsdt;
  }
  return grid;
}

function bandLabel(edges: number[], i: number): string {
  return `${edges[i].toFixed(3)}-${edges[i + 1].toFixed(3)}`;
}

async function main() {
  console.log(`\nStratified analysis: ${CONFIG.pair}  ${new Date(START_MS).toISOString().slice(0, 10)} → ${new Date(END_MS).toISOString().slice(0, 10)}`);

  console.log("Loading candles...");
  const candles1m = await fetchCandles("BTCUSDT", "1m", START_MS, END_MS);
  const candles5m = await fetchCandles("BTCUSDT", "5m", START_MS, END_MS);

  // Relax the strategy filters so we capture every fundamental signal —
  // we want the analysis to *discover* which filter cells are profitable,
  // not be pre-filtered by the current ones.
  const cfg: BacktestConfig = {
    emaFast: CONFIG.emaFast,
    emaSlow: CONFIG.emaSlow,
    emaTrend: CONFIG.emaTrend,
    emaFastTrend: CONFIG.emaFastTrend,
    emaSlowTrend: CONFIG.emaSlowTrend,
    atrPeriod: CONFIG.atrPeriod,
    atrAveragingPeriod: CONFIG.atrAveragingPeriod,
    noTradeEma200BandPct: CONFIG.noTradeEma200BandPct,
    noTradeAtrMultiplier: 0,        // disable ATR filter
    momentumConfirmPct: CONFIG.momentumConfirmPct,
    crossoverLookback: CONFIG.crossoverLookback,
    smartExitProfitPct: CONFIG.smartExitProfitPct,
    adxPeriod: 14,
    adxThreshold: 0,                // disable ADX filter
    stopLossPct: CONFIG.stopLossPct,
    takeProfitPct: CONFIG.takeProfitPct,
    dailyLossCapUsdt: CONFIG.dailyLossCapUsdt,
    tradeSizeUsdt: CONFIG.tradeSizeUsdt,
    cooldownCandles: CONFIG.cooldownCandles,
    candleLookback: CONFIG.candleLookback,
    trendCandleLookback: CONFIG.trendCandleLookback,
    recordFeatures: true,
  };

  console.log(`Running unfiltered backtest to collect all signal candidates...`);
  const trades = runBacktest(candles1m, candles5m, cfg);
  const withFeatures = trades.filter((t) => t.features);
  console.log(`Captured ${withFeatures.length} trades with features (${trades.length} total).\n`);

  if (withFeatures.length === 0) {
    console.log("No trades — aborting analysis.");
    return;
  }

  const overallWR = (withFeatures.filter((t) => t.pnlUsdt > 0).length / withFeatures.length) * 100;
  const overallPnl = withFeatures.reduce((s, t) => s + t.pnlUsdt, 0);
  console.log(`Overall (no filter):  WR ${overallWR.toFixed(1)}%   PnL ${fmtPnl(overallPnl)} USDT   over ${withFeatures.length} trades\n`);

  const line = "─".repeat(80);

  // ── Single-feature stratification ──────────────────────────────────────
  console.log(line);
  console.log("  SINGLE-FEATURE STRATIFICATION (quartile bins)");
  console.log(line);
  console.log(`  ${"feature".padEnd(20)} ${"bucket".padEnd(22)} ${"n".padStart(4)}  ${"WR%".padStart(6)}  ${"avgPnL".padStart(9)}  ${"totPnL".padStart(8)}`);
  console.log(line);

  const featureEdges: Partial<Record<keyof TradeFeatures, number[]>> = {};
  for (const f of FEATURE_NAMES) {
    const values = withFeatures.map((t) => t.features![f]);
    const edges = quantileEdges(values, QUANTILES);
    featureEdges[f] = edges;
    const buckets = single(withFeatures, f, edges);
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.n === 0) continue;
      const wr = (b.wins / b.n) * 100;
      const avgPnl = b.totalPnl / b.n;
      const label = bandLabel(edges, i);
      console.log(
        `  ${f.padEnd(20)} ${label.padEnd(22)} ${b.n.toString().padStart(4)}  ${wr.toFixed(1).padStart(6)}  ${fmtPnl(avgPnl).padStart(9)}  ${fmtPnl(b.totalPnl).padStart(8)}`
      );
    }
    console.log();
  }

  // Pick the two features with the strongest WR spread across buckets
  function spread(buckets: BucketStats[]): number {
    const wrs = buckets.filter((b) => b.n >= 10).map((b) => (b.wins / b.n) * 100);
    if (wrs.length < 2) return 0;
    return Math.max(...wrs) - Math.min(...wrs);
  }
  const ranked = FEATURE_NAMES.map((f) => ({
    f,
    spread: spread(single(withFeatures, f, featureEdges[f]!)),
  }))
    .sort((a, b) => b.spread - a.spread);

  console.log(line);
  console.log("  FEATURE RANKING BY WR SPREAD (strongest predictors first)");
  console.log(line);
  for (const r of ranked) {
    console.log(`  ${r.f.padEnd(20)}  spread ${r.spread.toFixed(1).padStart(5)} pp`);
  }
  console.log();

  // ── 2D contingency: top two features ───────────────────────────────────
  const topA = ranked[0].f;
  const topB = ranked[1].f;
  const aEdges = featureEdges[topA]!;
  const bEdges = featureEdges[topB]!;
  const grid = pair(withFeatures, topA, aEdges, topB, bEdges);

  console.log(line);
  console.log(`  2D CONTINGENCY:  ${topA}  ×  ${topB}`);
  console.log(line);
  console.log(`  rows = ${topA} (low → high), cols = ${topB} (low → high)`);
  console.log(`  cell shows: WR%  (n)   — cells with n<10 marked --`);
  console.log();
  let header = "  ".padStart(24);
  for (let bi = 0; bi < 4; bi++) {
    header += `${bandLabel(bEdges, bi).padStart(15)} `;
  }
  console.log(header);
  for (let ai = 0; ai < 4; ai++) {
    let row = `  ${bandLabel(aEdges, ai).padStart(20)}  `;
    for (let bi = 0; bi < 4; bi++) {
      const c = grid[ai][bi];
      if (c.n === 0) {
        row += `${"--".padStart(15)} `;
      } else if (c.n < 10) {
        row += `${`${((c.wins / c.n) * 100).toFixed(0)}%(${c.n})*`.padStart(15)} `;
      } else {
        row += `${`${((c.wins / c.n) * 100).toFixed(0)}%(${c.n})`.padStart(15)} `;
      }
    }
    console.log(row);
  }
  console.log(`\n  * = cell with <10 trades, statistically unreliable`);
  console.log();

  // ── Best high-confidence cells ─────────────────────────────────────────
  console.log(line);
  console.log("  TOP CELLS BY WR (n >= 10)");
  console.log(line);
  const cells: Array<{ a: number; b: number; n: number; wr: number; pnl: number }> = [];
  for (let ai = 0; ai < 4; ai++) {
    for (let bi = 0; bi < 4; bi++) {
      const c = grid[ai][bi];
      if (c.n >= 10) {
        cells.push({ a: ai, b: bi, n: c.n, wr: (c.wins / c.n) * 100, pnl: c.totalPnl });
      }
    }
  }
  cells.sort((a, b) => b.wr - a.wr);
  for (const c of cells) {
    console.log(
      `  ${topA}=${bandLabel(aEdges, c.a).padEnd(16)} ${topB}=${bandLabel(bEdges, c.b).padEnd(16)}  n=${c.n.toString().padStart(3)}  WR ${c.wr.toFixed(1).padStart(5)}%  totPnL ${fmtPnl(c.pnl).padStart(7)}`
    );
  }
  console.log(line);
}

main().catch((err) => {
  console.error("Analysis failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
