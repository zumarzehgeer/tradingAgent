import { CONFIG } from "./config";
import { logger } from "./logger";
import {
  getCandles,
  getPrice,
  getFreeBalance,
  marketBuyUsdt,
  marketSellAll,
} from "./binance";
import { decide } from "./strategy";
import { checkRisk } from "./risk";
import {
  loadState,
  saveState,
  rolloverIfNewDay,
  BotState,
} from "./state";

let stopRequested = false;

// Roughly $3 at $60k BTC. If BTC price changes dramatically, adjust this value.
const DUST_BTC = 0.00005;

class FatalStateMismatch extends Error {}

async function assertNoOrphanPosition(state: BotState): Promise<void> {
  if (state.position) return;
  if (CONFIG.ignoreOrphanBtc) return;
  const btcFree = await getFreeBalance(CONFIG.baseAsset);
  if (btcFree > DUST_BTC) {
    throw new FatalStateMismatch(
      `state.json shows no open position but account holds ${btcFree} BTC.\n` +
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
  if (btcFree < state.position.qtyBtc * 0.5) {
    throw new FatalStateMismatch(
      `state.json claims open position of ${state.position.qtyBtc} BTC at entry ${state.position.entryPrice}, ` +
        `but account only holds ${btcFree} BTC. ` +
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
    {
      entryPrice: state.position.entryPrice,
      exitPrice: fill.fillPrice,
      qty: state.position.qtyBtc,
      grossPnlUsdt: grossPnl,
      feesUsdt: totalFees,
      pnlUsdt: pnl,
      reason,
    },
    "trade closed"
  );
  return {
    ...state,
    position: null,
    dailyRealizedPnlUsdt: state.dailyRealizedPnlUsdt + pnl,
  };
}

async function tick(): Promise<void> {
  let state = await loadState(CONFIG.stateFile);
  state = rolloverIfNewDay(state);
  await assertNoOrphanPosition(state);
  state = await reconcile(state);

  const candles = await getCandles(CONFIG.pair, CONFIG.candleInterval, CONFIG.candleLookback);
  const price = await getPrice(CONFIG.pair);

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
  });

  logger.info(
    {
      action: d.action,
      reason: d.reason,
      indicators: d.indicators,
      dailyPnlUsdt: state.dailyRealizedPnlUsdt,
      hasPosition: !!state.position,
    },
    "tick"
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

async function main(): Promise<void> {
  logger.info(
    {
      pair: CONFIG.pair,
      tradeSizeUsdt: CONFIG.tradeSizeUsdt,
      testnet: CONFIG.testnet,
      stopLossPct: CONFIG.stopLossPct,
      takeProfitPct: CONFIG.takeProfitPct,
      dailyLossCapUsdt: CONFIG.dailyLossCapUsdt,
    },
    `bot starting (${CONFIG.testnet ? "TESTNET" : "LIVE"})`
  );

  const startupState = await loadState(CONFIG.stateFile);

  if (startupState.position) {
    const ageMs = Date.now() - startupState.position.entryTimestamp;
    const ageHours = ageMs / (60 * 60 * 1000);
    if (ageHours > 24) {
      logger.warn(
        {
          ageHours: ageHours.toFixed(1),
          entryPrice: startupState.position.entryPrice,
          qtyBtc: startupState.position.qtyBtc,
        },
        "open position is more than 24h old; SL/TP are computed from a stale entry. Verify manually before trading continues."
      );
    }
  }

  process.on("SIGINT", () => {
    logger.info("SIGINT received, will exit after current tick");
    stopRequested = true;
  });
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, will exit after current tick");
    stopRequested = true;
  });

  while (!stopRequested) {
    try {
      await tick();
    } catch (err) {
      if (err instanceof FatalStateMismatch) throw err;
      logger.error({ err: err instanceof Error ? err.message : err }, "tick error");
    }
    if (stopRequested) break;
    await new Promise((r) => setTimeout(r, CONFIG.pollIntervalMs));
  }

  logger.info("bot stopped");
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "fatal");
  logger.flush();
  process.exit(1);
});
