import Binance from "node-binance-api";

import { CONFIG } from "./config";
import { logger } from "./logger";

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FilledOrder {
  orderId: number;
  fillPrice: number;
  // Net base asset actually credited to the account (gross fill minus
  // base-asset commission, if any). Use this — never the gross executedQty —
  // when sizing a subsequent SELL, or you will over-sell and the exchange
  // will reject the order.
  qtyBase: number;
  quoteSpent: number;
  commissionUsdt: number;
}

export interface SymbolFilters {
  stepSize: number;
  minQty: number;
  minNotional: number;
}

// Throw this for errors that will not self-heal by retrying (bad config,
// missing symbol, implausible exchange-info values, response shape that
// doesn't match what we know how to parse). Transient errors (network
// blip, 429, 5xx) should remain plain Errors so the main loop's
// exponential backoff retries them.
export class StructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuralError";
  }
}

// Local, library-version-independent shape of the bits of a market order
// response we consume. Defined here rather than imported from the package
// because v1's shipped .d.ts isn't reliably resolvable across all
// TypeScript module resolution modes (tsc, ts-node, IDE).
interface OrderFillLike {
  qty: string;
  price: string;
  commission?: string;
  commissionAsset?: string;
}

interface OrderLike {
  orderId: number;
  side?: string;
  executedQty?: string;
  cummulativeQuoteQty?: string;
  fills?: OrderFillLike[];
}

interface RawCandle {
  openTime: number | string;
  closeTime: number | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
}

interface RawSymbolFilter {
  filterType: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
  notional?: string;
}

interface RawSymbolInfo {
  symbol: string;
  filters: RawSymbolFilter[];
}

const client = new Binance({
  APIKEY: CONFIG.apiKey,
  APISECRET: CONFIG.apiSecret,
  test: CONFIG.testnet,
  recvWindow: 10_000,
  useServerTime: true,
  // Route the library's internal logs through pino so verbose output is
  // structured and never bypasses the redact filter.
  log: (...args: unknown[]) =>
    logger.debug({ src: "node-binance-api" }, args.join(" ")),
});

function finiteOrThrow(value: unknown, field: string): number {
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `Exchange returned non-finite ${field}: ${JSON.stringify(value)}`,
    );
  }
  return n;
}

const FILTER_TTL_MS = 60 * 60 * 1000;
let filtersCache: { value: SymbolFilters; expiresAt: number } | null = null;
let filtersInflight: Promise<SymbolFilters> | null = null;

async function fetchFilters(symbol: string): Promise<SymbolFilters> {
  const info = (await client.exchangeInfo()) as unknown as { symbols: RawSymbolInfo[] };
  const sym = info.symbols.find((s: RawSymbolInfo) => s.symbol === symbol);
  if (!sym) throw new StructuralError(`Symbol ${symbol} not found in exchangeInfo`);
  const filters = sym.filters;
  const lot = filters.find((f: RawSymbolFilter) => f.filterType === "LOT_SIZE");
  if (!lot) throw new StructuralError(`No LOT_SIZE filter found for ${symbol}`);
  const notional = filters.find(
    (f: RawSymbolFilter) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL",
  );

  const stepSize = finiteOrThrow(lot.stepSize, "LOT_SIZE.stepSize");
  const minQty = finiteOrThrow(lot.minQty, "LOT_SIZE.minQty");
  const minNotional = notional
    ? finiteOrThrow(
        notional.minNotional ?? notional.notional ?? 0,
        "MIN_NOTIONAL",
      )
    : 0;

  if (stepSize <= 0 || stepSize > 1) {
    throw new StructuralError(`Implausible stepSize ${stepSize} for ${symbol}`);
  }
  if (minQty <= 0) {
    throw new StructuralError(`Implausible minQty ${minQty} for ${symbol}`);
  }

  return { stepSize, minQty, minNotional };
}

export async function loadFilters(symbol: string): Promise<SymbolFilters> {
  const now = Date.now();
  if (filtersCache && filtersCache.expiresAt > now) return filtersCache.value;
  if (filtersInflight) return filtersInflight;
  filtersInflight = (async () => {
    try {
      const value = await fetchFilters(symbol);
      filtersCache = { value, expiresAt: Date.now() + FILTER_TTL_MS };
      return value;
    } finally {
      filtersInflight = null;
    }
  })();
  return filtersInflight;
}

export function roundToStep(qty: number, step: number): number {
  if (
    !Number.isFinite(qty) ||
    !Number.isFinite(step) ||
    step <= 0 ||
    step > 1
  ) {
    throw new Error(
      `roundToStep called with invalid args qty=${qty} step=${step}`,
    );
  }
  // step like 0.00001 → 5 decimals. Truncate (don't round up) to stay below available balance.
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const factor = Math.pow(10, decimals);
  return Math.floor(qty * factor) / factor;
}

export async function getCandles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  // v1 returns Candle[] with named fields, all numerics as strings.
  // Drop the in-progress candle (closeTime > now) so the strategy never
  // reads a still-mutating close price — that would cause cross signals to flicker.
  const ticks = (await client.candlesticks(
    symbol,
    interval as never,
    { limit } as never,
  )) as unknown as RawCandle[];
  if (!Array.isArray(ticks)) {
    throw new Error(`candlesticks returned non-array: ${typeof ticks}`);
  }
  const now = Date.now();
  return ticks
    .map((t) => ({
      openTime: finiteOrThrow(t.openTime, "candle.openTime"),
      open: finiteOrThrow(t.open, "candle.open"),
      high: finiteOrThrow(t.high, "candle.high"),
      low: finiteOrThrow(t.low, "candle.low"),
      close: finiteOrThrow(t.close, "candle.close"),
      volume: finiteOrThrow(t.volume, "candle.volume"),
      closeTime: finiteOrThrow(t.closeTime, "candle.closeTime"),
    }))
    .filter((c) => c.closeTime <= now);
}

export async function getPrice(symbol: string): Promise<number> {
  const prices = (await client.prices(symbol)) as unknown as Record<string, unknown>;
  return finiteOrThrow(prices[symbol], `price[${symbol}]`);
}

export async function getFreeBalance(asset: string): Promise<number> {
  const balances = (await client.balance()) as unknown as Record<
    string,
    { available: string } | undefined
  >;
  const b = balances[asset];
  if (!b) {
    logger.warn(
      { asset, knownAssets: Object.keys(balances).slice(0, 10) },
      "asset not found in balance response",
    );
    return 0;
  }
  return finiteOrThrow(b.available, `balance[${asset}].available`);
}

interface ParsedFill {
  fillPrice: number;
  /** Gross filled base asset, before deducting any base-asset commission. */
  qtyGross: number;
  /** Base-asset commission deducted by the exchange. Zero if commission was paid in another asset. */
  baseCommission: number;
  quoteSpent: number;
  commissionUsdt: number;
}

function parseFills(order: OrderLike): ParsedFill {
  const fills: OrderFillLike[] = order.fills ?? [];

  if (fills.length === 0) {
    // Fallback: use cumulative quote and executed qty fields if fills aren't returned.
    // Approximate fee at 0.1% (Binance Spot taker rate without BNB discount).
    // Only a BUY can have its fee taken from the base asset (the BTC just
    // credited); for a SELL the fee is taken from the USDT proceeds, so
    // baseCommission is always 0 on the SELL path. We over-estimate
    // baseCommission for BUYs to be conservative — a slight under-statement
    // of qtyBase is safer than over-selling later.
    const qtyGross = finiteOrThrow(
      order.executedQty ?? "0",
      "order.executedQty",
    );
    const quote = finiteOrThrow(
      order.cummulativeQuoteQty ?? "0",
      "order.cummulativeQuoteQty",
    );
    const fillPrice = qtyGross > 0 ? quote / qtyGross : 0;
    const assumedBaseCommission = order.side === "BUY" ? qtyGross * 0.001 : 0;
    return {
      fillPrice,
      qtyGross,
      baseCommission: assumedBaseCommission,
      quoteSpent: quote,
      commissionUsdt: quote * 0.001,
    };
  }

  let qtyGross = 0;
  let quote = 0;
  let baseCommission = 0;
  let commissionUsdt = 0;

  for (const f of fills) {
    const fq = finiteOrThrow(f.qty, "fill.qty");
    const fp = finiteOrThrow(f.price, "fill.price");
    qtyGross += fq;
    quote += fq * fp;

    const commission = finiteOrThrow(f.commission ?? "0", "fill.commission");
    const asset = f.commissionAsset;
    if (asset === CONFIG.quoteAsset) {
      commissionUsdt += commission;
    } else if (asset === CONFIG.baseAsset) {
      // The exchange already debited this from the BUY's base-asset credit.
      // Track it so callers can size a subsequent SELL against the *net* qty.
      baseCommission += commission;
      commissionUsdt += commission * fp;
    } else {
      // BNB or other: approximate using the BNB-discount taker rate (0.075%)
      // applied to this fill's notional. Avoids an extra price lookup.
      commissionUsdt += fq * fp * 0.00075;
    }
  }

  return {
    fillPrice: qtyGross > 0 ? quote / qtyGross : 0,
    qtyGross,
    baseCommission,
    quoteSpent: quote,
    commissionUsdt,
  };
}

export async function marketBuyUsdt(
  symbol: string,
  usdtAmount: number,
): Promise<FilledOrder> {
  const filters = await loadFilters(symbol);
  const price = await getPrice(symbol);
  const rawQty = usdtAmount / price;
  const qty = roundToStep(rawQty, filters.stepSize);

  if (qty < filters.minQty) {
    throw new StructuralError(
      `Computed qty ${qty} below minQty ${filters.minQty} for ${symbol} (price ${price}). ` +
        `Increase tradeSizeUsdt in config.`,
    );
  }
  if (qty * price < filters.minNotional) {
    throw new StructuralError(
      `Notional ${qty * price} below minNotional ${filters.minNotional} for ${symbol}. ` +
        `Increase tradeSizeUsdt in config.`,
    );
  }

  logger.info(
    `BUY  submitting ${qty} ${symbol} @ ~${price.toFixed(2)} (${usdtAmount} USDT)`,
  );
  const order = (await client.marketBuy(symbol, qty)) as unknown as OrderLike;
  const parsed = parseFills(order);
  // qtyBase here is the NET base quantity actually credited — gross minus
  // any base-asset commission. This is what we record in state and what
  // marketSellAll must consume to avoid an over-sell.
  const qtyBase = parsed.qtyGross - parsed.baseCommission;

  if (qtyBase <= 0 || parsed.fillPrice <= 0) {
    throw new Error(
      `BUY order ${order.orderId} returned zero fill (qtyBase=${qtyBase}, fillPrice=${parsed.fillPrice}). ` +
        `State was NOT updated. Check Binance order history manually.`,
    );
  }

  logger.info(
    `BUY  filled #${order.orderId} ${qtyBase} ${symbol} @ ${parsed.fillPrice.toFixed(2)} | spent ${parsed.quoteSpent.toFixed(4)} USDT, fee ${parsed.commissionUsdt.toFixed(4)} USDT`,
  );

  return {
    orderId: order.orderId,
    fillPrice: parsed.fillPrice,
    qtyBase,
    quoteSpent: parsed.quoteSpent,
    commissionUsdt: parsed.commissionUsdt,
  };
}

export async function marketSellAll(
  symbol: string,
  qtyBase: number,
): Promise<FilledOrder> {
  const filters = await loadFilters(symbol);
  // Defense in depth: even if the caller's stored qtyBase is slightly stale,
  // never try to sell more than the account currently holds.
  const free = await getFreeBalance(CONFIG.baseAsset);
  const sellTarget = Math.min(qtyBase, free);
  const qty = roundToStep(sellTarget, filters.stepSize);

  if (qty < filters.minQty) {
    throw new Error(
      `Sell qty ${qty} below minQty ${filters.minQty} (requested=${qtyBase}, free=${free})`,
    );
  }

  logger.info(
    `SELL submitting ${qty} ${symbol} (requested ${qtyBase}, free ${free})`,
  );
  const order = (await client.marketSell(symbol, qty)) as unknown as OrderLike;
  const parsed = parseFills(order);
  // Symmetric with marketBuyUsdt: report the NET base quantity actually
  // disposed of, not the gross. Binance Spot SELL fees are typically taken
  // in USDT (baseCommission=0), but if the fee asset is BTC the gross
  // quantity overstates what we delivered, which would inflate exit
  // notional and PnL downstream.
  const qtyBaseNet = parsed.qtyGross - parsed.baseCommission;

  if (qtyBaseNet <= 0 || parsed.fillPrice <= 0) {
    throw new Error(
      `SELL order ${order.orderId} returned zero fill (qtyBase=${qtyBaseNet}, fillPrice=${parsed.fillPrice}). ` +
        `Position was NOT cleared. Check Binance order history manually.`,
    );
  }

  logger.info(
    `SELL filled #${order.orderId} ${qtyBaseNet} ${symbol} @ ${parsed.fillPrice.toFixed(2)} | got ${parsed.quoteSpent.toFixed(4)} USDT, fee ${parsed.commissionUsdt.toFixed(4)} USDT`,
  );

  return {
    orderId: order.orderId,
    fillPrice: parsed.fillPrice,
    qtyBase: qtyBaseNet,
    quoteSpent: parsed.quoteSpent,
    commissionUsdt: parsed.commissionUsdt,
  };
}
