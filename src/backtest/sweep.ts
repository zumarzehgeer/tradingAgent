import "dotenv/config";
import { CONFIG } from "../config";
import { fetchCandles } from "./download";
import { runBacktest, BacktestConfig, Trade } from "./engine";

const END_MS = Date.now();
const START_MS = END_MS - 1825 * 24 * 60 * 60 * 1000;

interface Variant {
  label: string;
  overrides: Partial<BacktestConfig>;
}

function summarize(label: string, trades: Trade[], days: number) {
  if (trades.length === 0) {
    return { label, trades: 0, winRate: 0, pf: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, maxDd: 0, perDay: 0 };
  }
  const wins = trades.filter((t) => t.pnlUsdt > 0);
  const losses = trades.filter((t) => t.pnlUsdt <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsdt, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsdt, 0));
  const totalPnl = grossWin - grossLoss;
  const pf = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  let equity = 0, peak = 0, maxDd = 0;
  for (const t of trades) {
    equity += t.pnlUsdt;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    label,
    trades: trades.length,
    winRate,
    pf,
    totalPnl,
    avgWin,
    avgLoss,
    maxDd,
    perDay: trades.length / days,
  };
}

function buildVariants(): Variant[] {
  const variants: Variant[] = [];

  // Use atrMult=1.5 as the new baseline since v1 sweep showed it's the only edge-positive entry filter.
  const ATRBASE: Partial<BacktestConfig> = { noTradeAtrMultiplier: 1.5 };

  variants.push({ label: "BASELINE (config defaults)  ", overrides: {} });
  variants.push({ label: "atr=1.5 baseline            ", overrides: { ...ATRBASE } });

  // ── ADX trend-strength filter ─────────────────────────────────────
  for (const adx of [15, 20, 25, 30]) {
    variants.push({
      label: `atr=1.5 adx>=${adx}              `.slice(0, 30),
      overrides: { ...ATRBASE, adxPeriod: 14, adxThreshold: adx },
    });
  }

  // ── Hour-of-day filter (UTC) ──────────────────────────────────────
  // BTC has well-known session patterns. Test major sessions on top of atr=1.5.
  // Asia: 00-07 UTC, EU: 07-14, US: 13-21, Late: 21-24
  const sessions: { name: string; hours: number[] }[] = [
    { name: "asia    ", hours: [0, 1, 2, 3, 4, 5, 6, 7] },
    { name: "eu      ", hours: [7, 8, 9, 10, 11, 12, 13] },
    { name: "us      ", hours: [13, 14, 15, 16, 17, 18, 19, 20] },
    { name: "us_open ", hours: [13, 14, 15, 16] },
    { name: "us+eu   ", hours: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
    { name: "no_late ", hours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  ];
  for (const s of sessions) {
    variants.push({
      label: `atr=1.5 hours=${s.name}     `.slice(0, 30),
      overrides: { ...ATRBASE, allowedHoursUtc: s.hours },
    });
  }

  // ── Stacked: ADX + best session ───────────────────────────────────
  for (const adx of [20, 25]) {
    variants.push({
      label: `atr=1.5 adx>=${adx} us+eu      `.slice(0, 30),
      overrides: { ...ATRBASE, adxPeriod: 14, adxThreshold: adx, allowedHoursUtc: sessions[4].hours },
    });
  }

  // ── ATR multiplier deeper ─────────────────────────────────────────
  for (const atrMult of [1.5, 1.75, 2.0]) {
    variants.push({
      label: `atr=${atrMult.toFixed(2)} adx>=20         `.slice(0, 30),
      overrides: { noTradeAtrMultiplier: atrMult, adxPeriod: 14, adxThreshold: 20 },
    });
  }

  return variants;
}

async function main() {
  console.log(`\nSweep: ${CONFIG.pair}  ${new Date(START_MS).toISOString().slice(0, 10)} → ${new Date(END_MS).toISOString().slice(0, 10)}`);

  console.log("Loading candles...");
  const candles1m = await fetchCandles("BTCUSDT", "1m", START_MS, END_MS);
  const candles5m = await fetchCandles("BTCUSDT", "5m", START_MS, END_MS);
  const days = (candles1m[candles1m.length - 1].closeTime - candles1m[0].openTime) / (1000 * 60 * 60 * 24);

  const baseCfg: BacktestConfig = {
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
  };

  const variants = buildVariants();
  console.log(`Running ${variants.length} variants...\n`);

  const results = [];
  for (const v of variants) {
    const cfg = { ...baseCfg, ...v.overrides };
    const t0 = Date.now();
    const trades = runBacktest(candles1m, candles5m, cfg);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const r = summarize(v.label, trades, days);
    results.push(r);
    process.stdout.write(`  ${v.label.padEnd(32)} → ${r.trades.toString().padStart(4)} trades  WR ${r.winRate.toFixed(1).padStart(4)}%  PF ${r.pf === Infinity ? " ∞ " : r.pf.toFixed(3).padStart(5)}  PnL ${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2)} USDT  (${elapsed}s)\n`);
  }

  // Sort by PF (treat Infinity as 999), then by total PnL
  results.sort((a, b) => {
    const pfA = a.pf === Infinity ? 999 : a.pf;
    const pfB = b.pf === Infinity ? 999 : b.pf;
    if (pfB !== pfA) return pfB - pfA;
    return b.totalPnl - a.totalPnl;
  });

  const line = "─".repeat(108);
  console.log(`\n${line}`);
  console.log("  RANKED RESULTS (by Profit Factor, then Total PnL)");
  console.log(line);
  console.log(`  ${"Variant".padEnd(32)}  ${"Trades".padStart(7)}  ${"/day".padStart(5)}  ${"WR%".padStart(5)}  ${"PF".padStart(6)}  ${"AvgW".padStart(7)}  ${"AvgL".padStart(7)}  ${"PnL$".padStart(8)}  ${"DD$".padStart(7)}`);
  console.log(line);
  for (const r of results) {
    const pfStr = r.pf === Infinity ? "  ∞  " : r.pf.toFixed(3);
    console.log(
      `  ${r.label.padEnd(32)}  ${r.trades.toString().padStart(7)}  ${r.perDay.toFixed(2).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}  ${pfStr.padStart(6)}  ${r.avgWin.toFixed(3).padStart(7)}  ${(-r.avgLoss).toFixed(3).padStart(7)}  ${((r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2)).padStart(8)}  ${(-r.maxDd).toFixed(2).padStart(7)}`
    );
  }
  console.log(line);

  const profitable = results.filter((r) => r.pf > 1 && r.pf !== Infinity && r.trades >= 30);
  if (profitable.length > 0) {
    console.log(`\n  ${profitable.length} variant(s) with PF > 1 and ≥30 trades:`);
    for (const r of profitable.slice(0, 5)) {
      console.log(`    ✓ ${r.label.trim()} — PF ${r.pf.toFixed(3)}, PnL ${r.totalPnl >= 0 ? "+" : ""}${r.totalPnl.toFixed(2)} USDT, ${r.trades} trades`);
    }
  } else {
    console.log(`\n  No variant achieved PF > 1 with ≥30 trades.`);
  }

  // ── 5m timeframe mini-sweep ─────────────────────────────────────────
  console.log("\n\nLoading 5m + 15m candles for higher-timeframe sweep...");
  const candles5mEntry = await fetchCandles("BTCUSDT", "5m", START_MS, END_MS);
  const candles15m = await fetchCandles("BTCUSDT", "15m", START_MS, END_MS);
  const days5m = (candles5mEntry[candles5mEntry.length - 1].closeTime - candles5mEntry[0].openTime) / (1000 * 60 * 60 * 24);

  // 5m moves are ~5x larger than 1m. Default SL/TP scales accordingly.
  const base5m: BacktestConfig = {
    ...baseCfg,
    stopLossPct: 0.015,
    takeProfitPct: 0.030,
    momentumConfirmPct: 0.0030, // tighter momentum for slower TF
    candleLookback: 250,
    trendCandleLookback: 220,
  };

  const variants5m: Variant[] = [
    { label: "5m baseline                 ", overrides: {} },
    { label: "5m atr=1.5                  ", overrides: { noTradeAtrMultiplier: 1.5 } },
    { label: "5m atr=1.5 adx>=20          ", overrides: { noTradeAtrMultiplier: 1.5, adxPeriod: 14, adxThreshold: 20 } },
    { label: "5m atr=1.5 adx>=25          ", overrides: { noTradeAtrMultiplier: 1.5, adxPeriod: 14, adxThreshold: 25 } },
    { label: "5m SL=1% TP=2%              ", overrides: { stopLossPct: 0.010, takeProfitPct: 0.020 } },
    { label: "5m SL=1% TP=2% atr=1.5      ", overrides: { stopLossPct: 0.010, takeProfitPct: 0.020, noTradeAtrMultiplier: 1.5 } },
    { label: "5m SL=2% TP=4%              ", overrides: { stopLossPct: 0.020, takeProfitPct: 0.040 } },
    { label: "5m SL=2% TP=4% atr=1.5      ", overrides: { stopLossPct: 0.020, takeProfitPct: 0.040, noTradeAtrMultiplier: 1.5 } },
    { label: "5m SL=2% TP=4% adx>=20      ", overrides: { stopLossPct: 0.020, takeProfitPct: 0.040, adxPeriod: 14, adxThreshold: 20 } },
  ];

  console.log(`Running ${variants5m.length} 5m variants...\n`);
  const results5m: ReturnType<typeof summarize>[] = [];
  for (const v of variants5m) {
    const cfg = { ...base5m, ...v.overrides };
    const t0 = Date.now();
    const trades = runBacktest(candles5mEntry, candles15m, cfg);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const r = summarize(v.label, trades, days5m);
    results5m.push(r);
    process.stdout.write(`  ${v.label.padEnd(32)} → ${r.trades.toString().padStart(4)} trades  WR ${r.winRate.toFixed(1).padStart(4)}%  PF ${r.pf === Infinity ? " ∞ " : r.pf.toFixed(3).padStart(5)}  PnL ${(r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2)} USDT  (${elapsed}s)\n`);
  }

  results5m.sort((a, b) => {
    const pfA = a.pf === Infinity ? 999 : a.pf;
    const pfB = b.pf === Infinity ? 999 : b.pf;
    if (pfB !== pfA) return pfB - pfA;
    return b.totalPnl - a.totalPnl;
  });

  console.log(`\n${line}`);
  console.log("  5m TIMEFRAME RESULTS (sorted)");
  console.log(line);
  console.log(`  ${"Variant".padEnd(32)}  ${"Trades".padStart(7)}  ${"/day".padStart(5)}  ${"WR%".padStart(5)}  ${"PF".padStart(6)}  ${"AvgW".padStart(7)}  ${"AvgL".padStart(7)}  ${"PnL$".padStart(8)}  ${"DD$".padStart(7)}`);
  console.log(line);
  for (const r of results5m) {
    const pfStr = r.pf === Infinity ? "  ∞  " : r.pf.toFixed(3);
    console.log(
      `  ${r.label.padEnd(32)}  ${r.trades.toString().padStart(7)}  ${r.perDay.toFixed(2).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}  ${pfStr.padStart(6)}  ${r.avgWin.toFixed(3).padStart(7)}  ${(-r.avgLoss).toFixed(3).padStart(7)}  ${((r.totalPnl >= 0 ? "+" : "") + r.totalPnl.toFixed(2)).padStart(8)}  ${(-r.maxDd).toFixed(2).padStart(7)}`
    );
  }
  console.log(line);
}

main().catch((err) => {
  console.error("Sweep failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
