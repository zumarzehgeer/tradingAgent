import { promises as fs } from "fs";
import path from "path";

export interface OpenPosition {
  entryPrice: number;
  qtyBtc: number;
  entryTimestamp: number;
  entryCommissionUsdt: number;
}

export interface BotState {
  position: OpenPosition | null;
  dayUtc: string;
  dailyRealizedPnlUsdt: number;
}

const EMPTY_STATE: BotState = {
  position: null,
  dayUtc: todayUtc(),
  dailyRealizedPnlUsdt: 0,
};

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadState(file: string): Promise<BotState> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as BotState;
    return {
      position: parsed.position
        ? {
            entryPrice: parsed.position.entryPrice,
            qtyBtc: parsed.position.qtyBtc,
            entryTimestamp: parsed.position.entryTimestamp,
            entryCommissionUsdt: parsed.position.entryCommissionUsdt ?? 0,
          }
        : null,
      dayUtc: parsed.dayUtc ?? todayUtc(),
      dailyRealizedPnlUsdt: parsed.dailyRealizedPnlUsdt ?? 0,
    };
  } catch (err: any) {
    if (err.code === "ENOENT") return { ...EMPTY_STATE };
    throw err;
  }
}

export async function saveState(file: string, state: BotState): Promise<void> {
  const tmp = file + ".tmp";
  const dir = path.dirname(path.resolve(file));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

export function rolloverIfNewDay(state: BotState): BotState {
  const today = todayUtc();
  if (state.dayUtc === today) return state;
  return { ...state, dayUtc: today, dailyRealizedPnlUsdt: 0 };
}
