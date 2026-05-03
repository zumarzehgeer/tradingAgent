import { promises as fs } from "fs";
import path from "path";
import { Candle } from "../binance";

const BASE_URL = "https://api.binance.com/api/v3/klines";
const BATCH = 1000;
const RATE_LIMIT_MS = 100;

function dateTag(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

function cacheFile(symbol: string, interval: string, startMs: number, endMs: number): string {
  return path.resolve("data", `${symbol}_${interval}_${dateTag(startMs)}_${dateTag(endMs)}.json`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawKline {
  0: number; // openTime
  1: string; // open
  2: string; // high
  3: string; // low
  4: string; // close
  5: string; // volume
  6: number; // closeTime
}

function parseKline(raw: RawKline): Candle {
  return {
    openTime: raw[0],
    closeTime: raw[6],
    open: parseFloat(raw[1]),
    high: parseFloat(raw[2]),
    low: parseFloat(raw[3]),
    close: parseFloat(raw[4]),
    volume: parseFloat(raw[5]),
  };
}

// Approximate total candles for a 1m/5m interval given ms duration
function approxTotal(interval: string, durationMs: number): number {
  const intervalMs =
    interval === "1m" ? 60_000 :
    interval === "5m" ? 300_000 :
    interval === "15m" ? 900_000 :
    interval === "1h" ? 3_600_000 :
    60_000;
  return Math.ceil(durationMs / intervalMs);
}

export type CandleInterval = "1m" | "5m" | "15m" | "1h";

export async function fetchCandles(
  symbol: string,
  interval: CandleInterval,
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const file = cacheFile(symbol, interval, startMs, endMs);

  try {
    const raw = await fs.readFile(file, "utf-8");
    const cached: Candle[] = JSON.parse(raw);
    console.log(`  [cache] ${path.basename(file)} — ${cached.length} candles`);
    return cached;
  } catch {
    // Not cached — download below
  }

  const total = approxTotal(interval, endMs - startMs);
  const candles: Candle[] = [];
  let cursor = startMs;
  let batches = 0;

  process.stdout.write(`  Fetching ${interval} candles: 0 / ~${total}`);

  while (cursor < endMs) {
    const url =
      `${BASE_URL}?symbol=${symbol}&interval=${interval}` +
      `&limit=${BATCH}&startTime=${cursor}&endTime=${endMs}`;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Binance klines HTTP ${resp.status}: ${await resp.text()}`);
    }

    const batch = (await resp.json()) as RawKline[];
    if (batch.length === 0) break;

    for (const raw of batch) {
      const c = parseKline(raw);
      if (c.closeTime <= endMs) candles.push(c);
    }

    cursor = batch[batch.length - 1][0] + 1; // next openTime
    batches++;

    process.stdout.write(`\r  Fetching ${interval} candles: ${candles.length} / ~${total}`);

    if (batch.length < BATCH) break; // last page
    if (batches % 10 === 0) await sleep(RATE_LIMIT_MS);
  }

  process.stdout.write(`\r  Fetched  ${interval} candles: ${candles.length}              \n`);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(candles), "utf-8");
  console.log(`  [saved]  ${path.basename(file)}`);

  return candles;
}
