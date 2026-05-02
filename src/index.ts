import { CONFIG } from "./config";
import { logger } from "./logger";
import {
  getCandles,
  getPrice,
  getFreeBalance,
  loadFilters,
  marketBuyUsdt,
  marketSellAll,
  StructuralError,
} from "./binance";
import { decide } from "./strategy";
import { checkRisk } from "./risk";
import {
  loadState,
  saveState,
  rolloverIfNewDay,
  BotState,
  StateValidationError,
} from "./state";

let stopRequested = false;

class FatalStateMismatch extends Error {}

// Derive the orphan-BTC threshold from the live exchange step size rather
// than a hardcoded constant. At step=0.00001, the threshold is 0.00002 — two
// step sizes, comfortably above any settlement noise but well below a $10
// trade's worth of BTC at any plausible price.
async function dustThresholdBtc(): Promise<number> {
  const filters = await loadFilters(CONFIG.pair);
  return filters.stepSize * 2;
}

async function assertNoOrphanPosition(state: BotState): Promise<void> {
  if (state.position) return;
  if (CONFIG.ignoreOrphanBtc) return;
  const [btcFree, dust] = await Promise.all([
    getFreeBalance(CONFIG.baseAsset),
    dustThresholdBtc(),
  ]);
  if (btcFree > dust) {
    throw new FatalStateMismatch(
      `state.json shows no open position but account holds ${btcFree} BTC (dust threshold ${dust}).\n` +
        `  Path A — BTC is from this bot (saveState failed after a BUY):\n` +
        `    Sell the BTC on Binance manually, then restart.\n` +
        `  Path B — BTC is yours and unrelated to this bot (long-term holdings, etc.):\n` +
        `    Set BINANCE_IGNORE_ORPHAN_BTC=true in .env, then restart.\n` +
        `    The bot will not manage that BTC — it will only buy when its own signal fires.`
    );
  }
}

async function reconcile(state: BotState): Promise<BotState> {
  if (!state.position) return state;
  const btcFree = await getFreeBalance(CONFIG.baseAsset);
  // Tight reconciliation: account must hold at least 95% of recorded qty.
  // A wider tolerance lets a partial manual sell pass undetected, after
  // which the bot would later try to sell more BTC than it owns.
  if (btcFree < state.position.qtyBtc * 0.95) {
    throw new FatalStateMismatch(
      `state.json claims open position of ${state.position.qtyBtc} BTC at entry ${state.position.entryPrice}, ` +
        `but account only holds ${btcFree} BTC (need >= 95%). ` +
        `Either the position was sold outside the bot, or state is stale. ` +
        `Resolve manually: delete state.json (you'll lose the entry-price record and today's P&L) and restart.`
    );
  }
  return state;
}

async function executeBuy(state: BotState): Promise<BotState> {
  const fill = await marketBuyUsdt(CONFIG.pair, CONFIG.tradeSizeUsdt);
  return {
    ...state,
    position: {
      entryPrice: fill.fillPrice,
      qtyBtc: fill.qtyBase,
      entryTimestamp: Date.now(),
      entryCommissionUsdt: fill.commissionUsdt,
    },
  };
}

async function executeSell(state: BotState, reason: string): Promise<BotState> {
  if (!state.position) {
    logger.warn({ reason }, "sell requested but no position open; skipping");
    return state;
  }
  const fill = await marketSellAll(CONFIG.pair, state.position.qtyBtc);
  const entryNotional = state.position.entryPrice * state.position.qtyBtc;
  const exitNotional = fill.fillPrice * fill.qtyBase;
  const grossPnl = exitNotional - entryNotional;
  const totalFees = state.position.entryCommissionUsdt + fill.commissionUsdt;
  const pnl = grossPnl - totalFees;
  logger.info(
    `CLOSED entry ${state.position.entryPrice.toFixed(2)} → exit ${fill.fillPrice.toFixed(2)} | qty ${state.position.qtyBtc} | gross ${grossPnl >= 0 ? "+" : ""}${grossPnl.toFixed(4)} fees ${totalFees.toFixed(4)} → net ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDT — ${reason}`
  );
  return {
    ...state,
    position: null,
    dailyRealizedPnlUsdt: state.dailyRealizedPnlUsdt + pnl,
    dailyTradeCount: state.dailyTradeCount + 1,
  };
}

async function tick(): Promise<void> {
  let state = await loadState(CONFIG.stateFile);
  state = rolloverIfNewDay(state);
  await assertNoOrphanPosition(state);
  state = await reconcile(state);

  if (state.position) {
    const ageHours = (Date.now() - state.position.entryTimestamp) / (60 * 60 * 1000);
    if (ageHours > CONFIG.maxPositionAgeHours) {
      throw new FatalStateMismatch(
        `Open position is ${ageHours.toFixed(1)}h old (limit ${CONFIG.maxPositionAgeHours}h). ` +
          `SL/TP are computed from a potentially stale entry price. Resolve manually: ` +
          `decide whether to hold or close on Binance, then delete state.json (or update entryTimestamp) and restart.`
      );
    }
  }

  const [candles, price] = await Promise.all([
    getCandles(CONFIG.pair, CONFIG.candleInterval, CONFIG.candleLookback),
    getPrice(CONFIG.pair),
  ]);

  const risk = checkRisk(state, price, {
    stopLossPct: CONFIG.stopLossPct,
    takeProfitPct: CONFIG.takeProfitPct,
    dailyLossCapUsdt: CONFIG.dailyLossCapUsdt,
  });

  if (risk.action === "FORCE_SELL") {
    logger.warn({ reason: risk.reason }, "risk forced exit");
    state = await executeSell(state, risk.reason);
    await saveState(CONFIG.stateFile, state);
    return;
  }

  const d = decide(candles, state.position, {
    emaFast: CONFIG.emaFast,
    emaSlow: CONFIG.emaSlow,
    rsiPeriod: CONFIG.rsiPeriod,
    rsiOverbought: CONFIG.rsiOverbought,
    rsiOversold: CONFIG.rsiOversold,
  });

  const unrealizedPct = state.position
    ? ((price - state.position.entryPrice) / state.position.entryPrice) * 100
    : null;
  const unrealizedUsdt = state.position
    ? (price - state.position.entryPrice) * state.position.qtyBtc
    : null;

  const fastVsSlow = d.indicators.emaFast >= d.indicators.emaSlow ? ">" : "<";
  const positionTag =
    state.position && unrealizedPct !== null && unrealizedUsdt !== null
      ? ` | pos@${state.position.entryPrice.toFixed(2)} ${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(2)}% (${unrealizedUsdt >= 0 ? "+" : ""}${unrealizedUsdt.toFixed(2)} USDT)`
      : "";
  const prettyLine = `${d.action.padEnd(4)} ${d.indicators.price.toFixed(2)} | ema ${d.indicators.emaFast.toFixed(2)}${fastVsSlow}${d.indicators.emaSlow.toFixed(2)} rsi ${d.indicators.rsi.toFixed(1)} | day ${state.dailyRealizedPnlUsdt >= 0 ? "+" : ""}${state.dailyRealizedPnlUsdt.toFixed(2)} USDT (${state.dailyTradeCount} trades)${positionTag} — ${d.reason}`;

  // Pass both: structured fields (for JSON log aggregators that filter by
  // action/rsi/pnl) AND a human-readable msg (for pretty terminal output).
  // pino-pretty renders the msg prominently; JSON consumers see all fields.
  logger.info(
    {
      action: d.action,
      price: d.indicators.price,
      emaFast: d.indicators.emaFast,
      emaSlow: d.indicators.emaSlow,
      rsi: d.indicators.rsi,
      dailyPnlUsdt: +state.dailyRealizedPnlUsdt.toFixed(4),
      dailyTradeCount: state.dailyTradeCount,
      ...(unrealizedPct !== null && unrealizedUsdt !== null && state.position
        ? {
            entryPrice: state.position.entryPrice,
            unrealizedPnlUsdt: +unrealizedUsdt.toFixed(4),
            unrealizedPnlPct: +unrealizedPct.toFixed(3),
          }
        : {}),
      reason: d.reason,
    },
    prettyLine,
  );

  if (d.action === "BUY") {
    if (risk.action === "BLOCK_BUYS") {
      logger.warn({ reason: risk.reason }, "BUY blocked by risk");
      return;
    }
    state = await executeBuy(state);
  } else if (d.action === "SELL") {
    state = await executeSell(state, d.reason);
  }

  await saveState(CONFIG.stateFile, state);
}

function backoffMs(failures: number): number {
  // 1s, 2s, 4s, 8s, 16s, 32s, capped at 60s. Even at the cap, a sustained
  // 429/IP-ban won't hammer the endpoint faster than the normal poll rate.
  return Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6));
}

async function main(): Promise<void> {
  if (!CONFIG.testnet) {
    // 5-second pause with a loud banner before the first tick. Gives an
    // operator who set BINANCE_LIVE=true by mistake a chance to Ctrl+C.
    logger.warn("!!! LIVE MODE — REAL FUNDS WILL BE TRADED !!!");
    logger.warn({ tradeSizeUsdt: CONFIG.tradeSizeUsdt }, "starting in 5s, Ctrl+C to abort");
    await new Promise((r) => setTimeout(r, 5000));
  }

  const slPct = (CONFIG.stopLossPct * 100).toFixed(2);
  const tpPct = (CONFIG.takeProfitPct * 100).toFixed(2);
  logger.info(
    `bot starting [${CONFIG.testnet ? "TESTNET" : "LIVE"}] ${CONFIG.pair} | size ${CONFIG.tradeSizeUsdt} USDT | SL -${slPct}% TP +${tpPct}% | daily cap ${CONFIG.dailyLossCapUsdt} USDT`
  );

  process.on("SIGINT", () => {
    logger.info("SIGINT received, will exit after current tick");
    stopRequested = true;
  });
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, will exit after current tick");
    stopRequested = true;
  });

  let consecutiveFailures = 0;

  while (!stopRequested) {
    try {
      await tick();
      consecutiveFailures = 0;
    } catch (err) {
      // Halt immediately on errors that won't self-heal by retrying.
      if (err instanceof FatalStateMismatch) throw err;
      if (err instanceof StateValidationError) throw err;
      if (err instanceof StructuralError) throw err;
      consecutiveFailures += 1;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: message, consecutiveFailures },
        "tick error"
      );
      if (consecutiveFailures >= CONFIG.maxConsecutiveTickErrors) {
        throw new Error(
          `Halting: ${consecutiveFailures} consecutive tick errors (limit ${CONFIG.maxConsecutiveTickErrors}). Last: ${message}`
        );
      }
    }
    if (stopRequested) break;
    const sleepMs =
      consecutiveFailures > 0 ? backoffMs(consecutiveFailures) : CONFIG.pollIntervalMs;
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  logger.info("bot stopped");
}

async function shutdown(code: number): Promise<never> {
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  process.exit(code);
}

main().then(
  () => shutdown(0),
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "fatal");
    return shutdown(1);
  }
);
