import { Candle } from "../binance";
import { Trade } from "./engine";

function fmt(n: number, decimals = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(decimals);
}

function pad(s: string, width: number): string {
  return s.padEnd(width);
}

export function printReport(trades: Trade[], candles1m: Candle[]): void {
  if (trades.length === 0) {
    console.log("\n  No trades executed in backtest period.");
    return;
  }

  const wins = trades.filter((t) => t.pnlUsdt > 0);
  const losses = trades.filter((t) => t.pnlUsdt <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsdt, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsdt, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsdt, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossWin / grossLoss;
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  // Max drawdown on running equity curve
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnlUsdt;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDdPct = peak > 0 ? (maxDd / peak) * 100 : 0;

  // Trading period
  const firstMs = candles1m[0].openTime;
  const lastMs = candles1m[candles1m.length - 1].closeTime;
  const days = (lastMs - firstMs) / (1000 * 60 * 60 * 24);
  const tradesPerDay = trades.length / days;

  // Exit breakdown — count, total PnL, and avg PnL per reason
  const byReason: Record<string, { count: number; totalPnl: number; wins: number }> = {};
  for (const t of trades) {
    const r = (byReason[t.exitReason] ??= { count: 0, totalPnl: 0, wins: 0 });
    r.count += 1;
    r.totalPnl += t.pnlUsdt;
    if (t.pnlUsdt > 0) r.wins += 1;
  }

  // Monthly equity curve
  const monthlyPnl: Record<string, number> = {};
  for (const t of trades) {
    const key = new Date(t.exitTime).toISOString().slice(0, 7); // "YYYY-MM"
    monthlyPnl[key] = (monthlyPnl[key] ?? 0) + t.pnlUsdt;
  }

  const line = "─".repeat(52);
  console.log(`\n${line}`);
  console.log("  BACKTEST RESULTS");
  console.log(line);
  console.log(`  Period        : ${new Date(firstMs).toISOString().slice(0, 10)} → ${new Date(lastMs).toISOString().slice(0, 10)}  (${days.toFixed(0)} days)`);
  console.log(`  Trade size    : $10 USDT  |  Fee rate: 0.1% taker`);
  console.log(line);
  console.log(`  Total trades  : ${trades.length}  (${tradesPerDay.toFixed(2)}/day)`);
  console.log(`  Win rate      : ${winRate.toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Profit factor : ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(3)}`);
  console.log(`  Total P&L     : ${fmt(totalPnl)} USDT`);
  console.log(`  Avg win       : ${fmt(avgWin)} USDT`);
  console.log(`  Avg loss      : ${fmt(-avgLoss)} USDT`);
  console.log(`  Max drawdown  : ${fmt(-maxDd)} USDT  (${maxDdPct.toFixed(1)}%)`);
  console.log(line);
  console.log("  Exit breakdown (count, win%, totalPnL, avgPnL):");
  for (const [reason, r] of Object.entries(byReason).sort()) {
    const pct = (r.count / trades.length) * 100;
    const winPct = (r.wins / r.count) * 100;
    const avgPnl = r.totalPnl / r.count;
    console.log(
      `    ${pad(reason, 12)} ${r.count.toString().padStart(4)}  (${pct.toFixed(1)}%)  win ${winPct.toFixed(0).padStart(3)}%  tot ${fmt(r.totalPnl).padStart(8)}  avg ${fmt(avgPnl, 4).padStart(9)}`
    );
  }
  console.log(line);
  console.log("  Monthly P&L:");
  let cumulative = 0;
  for (const [month, pnl] of Object.entries(monthlyPnl).sort()) {
    cumulative += pnl;
    const bar =
      pnl >= 0
        ? "▓".repeat(Math.min(20, Math.round(pnl * 2)))
        : "░".repeat(Math.min(20, Math.round(Math.abs(pnl) * 2)));
    console.log(
      `    ${month}  ${fmt(pnl).padStart(8)} USDT  (cum ${fmt(cumulative).padStart(8)})  ${bar}`
    );
  }
  console.log(line);

  // Verdict
  const verdict =
    profitFactor >= 1.5 && maxDdPct < 15
      ? "✅ STRONG — consider live testing on testnet"
      : profitFactor >= 1.2 && maxDdPct < 25
      ? "🟡 MARGINAL — viable but tune before going live"
      : "❌ WEAK — do NOT go live, strategy needs rework";
  console.log(`  Verdict       : ${verdict}`);
  console.log(line + "\n");
}
