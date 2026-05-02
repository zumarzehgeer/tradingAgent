import { BotState } from "./state";

export type RiskAction = "FORCE_SELL" | "BLOCK_BUYS" | "OK";

export interface RiskCheck {
  action: RiskAction;
  reason: string;
}

export interface RiskParams {
  stopLossPct: number;
  takeProfitPct: number;
  dailyLossCapUsdt: number;
}

export function checkRisk(
  state: BotState,
  currentPrice: number,
  params: RiskParams
): RiskCheck {
  if (state.position) {
    const { entryPrice } = state.position;
    const slPrice = entryPrice * (1 - params.stopLossPct);
    const tpPrice = entryPrice * (1 + params.takeProfitPct);

    if (currentPrice <= slPrice) {
      return {
        action: "FORCE_SELL",
        reason: `stop-loss hit: price ${currentPrice.toFixed(2)} <= ${slPrice.toFixed(2)} (entry ${entryPrice.toFixed(2)}, -${(params.stopLossPct * 100).toFixed(2)}%)`,
      };
    }
    if (currentPrice >= tpPrice) {
      return {
        action: "FORCE_SELL",
        reason: `take-profit hit: price ${currentPrice.toFixed(2)} >= ${tpPrice.toFixed(2)} (entry ${entryPrice.toFixed(2)}, +${(params.takeProfitPct * 100).toFixed(2)}%)`,
      };
    }
  }

  // Daily loss cap counts BOTH realized PnL and unrealized PnL on any open
  // position. If we counted only realized, a deeply underwater open position
  // would not block new buys until SL closed it — by which point the cap
  // would already be breached.
  const unrealized = state.position
    ? (currentPrice - state.position.entryPrice) * state.position.qtyBtc
    : 0;
  const totalDayPnl = state.dailyRealizedPnlUsdt + unrealized;

  if (totalDayPnl <= -params.dailyLossCapUsdt) {
    return {
      action: "BLOCK_BUYS",
      reason: `daily loss cap reached: total ${totalDayPnl.toFixed(2)} USDT (realized ${state.dailyRealizedPnlUsdt.toFixed(2)} + unrealized ${unrealized.toFixed(2)}, cap -${params.dailyLossCapUsdt})`,
    };
  }

  return { action: "OK", reason: "" };
}
