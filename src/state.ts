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
  dailyTradeCount: number;
  cooldownCandlesRemaining: number;
}

export class StateValidationError extends Error {}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function emptyState(): BotState {
  return {
    position: null,
    dayUtc: todayUtc(),
    dailyRealizedPnlUsdt: 0,
    dailyTradeCount: 0,
    cooldownCandlesRemaining: 0,
  };
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StateValidationError(
      `state.json has invalid ${field}: ${JSON.stringify(value)}. ` +
        `Resolve manually: stop the bot, sell any open BTC on Binance, delete state.json, restart.`
    );
  }
  return value;
}

function validatePosition(raw: unknown): OpenPosition | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") {
    throw new StateValidationError(`state.json position is not an object: ${JSON.stringify(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  return {
    entryPrice: finite(r.entryPrice, "position.entryPrice"),
    qtyBtc: finite(r.qtyBtc, "position.qtyBtc"),
    entryTimestamp: finite(r.entryTimestamp, "position.entryTimestamp"),
    entryCommissionUsdt: finite(r.entryCommissionUsdt ?? 0, "position.entryCommissionUsdt"),
  };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

export async function loadState(file: string): Promise<BotState> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return emptyState();
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateValidationError(`state.json is not valid JSON. Delete it to start fresh.`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new StateValidationError(`state.json root is not an object`);
  }
  const p = parsed as Record<string, unknown>;

  return {
    position: validatePosition(p.position),
    dayUtc: typeof p.dayUtc === "string" ? p.dayUtc : todayUtc(),
    dailyRealizedPnlUsdt: finite(p.dailyRealizedPnlUsdt ?? 0, "dailyRealizedPnlUsdt"),
    dailyTradeCount: finite(p.dailyTradeCount ?? 0, "dailyTradeCount"),
    cooldownCandlesRemaining:
      typeof p.cooldownCandlesRemaining === "number" && Number.isFinite(p.cooldownCandlesRemaining)
        ? Math.max(0, Math.floor(p.cooldownCandlesRemaining))
        : 0,
  };
}

export async function saveState(file: string, state: BotState): Promise<void> {
  const tmp = file + ".tmp";
  const dir = path.dirname(path.resolve(file));
  await fs.mkdir(dir, { recursive: true });

  // Refuse to overwrite a symlink. fs.rename follows symlinks at the
  // destination, so a malicious symlink at state.json could redirect the
  // write to an arbitrary file. Detect with lstat (does NOT follow links).
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Refusing to overwrite ${file}: it is a symbolic link. ` +
          `Delete the symlink and restart, or move the state file to a directory you control.`
      );
    }
  } catch (err: unknown) {
    if (!(isErrnoException(err) && err.code === "ENOENT")) throw err;
  }

  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export function rolloverIfNewDay(state: BotState): BotState {
  const today = todayUtc();
  if (state.dayUtc === today) return state;
  // cooldownCandlesRemaining intentionally NOT reset: a cooldown started at
  // 23:59 should continue to protect the first ticks of the next UTC day.
  return { ...state, dayUtc: today, dailyRealizedPnlUsdt: 0, dailyTradeCount: 0 };
}
