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

  if (state.dailyRealizedPnlUsdt <= -params.dailyLossCapUsdt) {
    return {
      action: "BLOCK_BUYS",
      reason: `daily loss cap reached: ${state.dailyRealizedPnlUsdt.toFixed(2)} USDT (cap -${params.dailyLossCapUsdt})`,
    };
  }

  return { action: "OK", reason: "" };
}
