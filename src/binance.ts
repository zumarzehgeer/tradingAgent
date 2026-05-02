// node-binance-api ships no types, so declare a loose module surface.
// We only touch a small subset of the API.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Binance = require("node-binance-api");

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
  qtyBase: number;
  quoteSpent: number;
  commissionUsdt: number;
}

interface SymbolFilters {
  stepSize: number;
  minQty: number;
  minNotional: number;
}

const TESTNET_BASE = "https://testnet.binance.vision/api/";

const client = new Binance().options({
  APIKEY: CONFIG.apiKey,
  APISECRET: CONFIG.apiSecret,
  recvWindow: 10_000,
  useServerTime: true,
  ...(CONFIG.testnet ? { urls: { base: TESTNET_BASE } } : {}),
});

let cachedFilters: SymbolFilters | null = null;

async function loadFilters(symbol: string): Promise<SymbolFilters> {
  if (cachedFilters) return cachedFilters;
  const info: any = await client.exchangeInfo();
  const sym = info.symbols.find((s: any) => s.symbol === symbol);
  if (!sym) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
  const lot = sym.filters.find((f: any) => f.filterType === "LOT_SIZE");
  const notional = sym.filters.find(
    (f: any) => f.filterType === "MIN_NOTIONAL" || f.filterType === "NOTIONAL"
  );
  cachedFilters = {
    stepSize: parseFloat(lot.stepSize),
    minQty: parseFloat(lot.minQty),
    minNotional: notional ? parseFloat(notional.minNotional ?? notional.notional ?? "0") : 0,
  };
  return cachedFilters;
}

function roundToStep(qty: number, step: number): number {
  // step like 0.00001 → 5 decimals. Truncate (don't round up) to stay below available balance.
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const factor = Math.pow(10, decimals);
  return Math.floor(qty * factor) / factor;
}

export async function getCandles(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[]> {
  // node-binance-api's candlesticks() callback returns ticks as nested arrays.
  // Drop the in-progress candle (closeTime > now) so the strategy never reads
  // a still-mutating close price — that would cause cross signals to flicker.
  return new Promise((resolve, reject) => {
    client.candlesticks(
      symbol,
      interval,
      (err: any, ticks: any[]) => {
        if (err) return reject(err);
        const now = Date.now();
        const candles: Candle[] = ticks
          .map((t) => ({
            openTime: Number(t[0]),
            open: parseFloat(t[1]),
            high: parseFloat(t[2]),
            low: parseFloat(t[3]),
            close: parseFloat(t[4]),
            volume: parseFloat(t[5]),
            closeTime: Number(t[6]),
          }))
          .filter((c) => c.closeTime <= now);
        resolve(candles);
      },
      { limit }
    );
  });
}

export async function getPrice(symbol: string): Promise<number> {
  const prices: Record<string, string> = await client.prices(symbol);
  const p = parseFloat(prices[symbol]);
  if (!Number.isFinite(p)) throw new Error(`Bad price for ${symbol}: ${prices[symbol]}`);
  return p;
}

export async function getFreeBalance(asset: string): Promise<number> {
  const balances: any = await client.balance();
  const b = balances[asset];
  return b ? parseFloat(b.available) : 0;
}

function parseFills(order: any): {
  fillPrice: number;
  qtyBase: number;
  quoteSpent: number;
  commissionUsdt: number;
} {
  const fills: any[] = order.fills ?? [];
  if (fills.length === 0) {
    // Fallback: use cumulative quote and executed qty fields if fills aren't returned.
    // Approximate fee at 0.1% (Binance Spot taker rate without BNB discount).
    const qty = parseFloat(order.executedQty ?? "0");
    const quote = parseFloat(order.cummulativeQuoteQty ?? "0");
    const px = qty > 0 ? quote / qty : 0;
    return { fillPrice: px, qtyBase: qty, quoteSpent: quote, commissionUsdt: quote * 0.001 };
  }
  let qty = 0;
  let quote = 0;
  let commissionUsdt = 0;
  for (const f of fills) {
    const fq = parseFloat(f.qty);
    const fp = parseFloat(f.price);
    qty += fq;
    quote += fq * fp;

    const commission = parseFloat(f.commission ?? "0");
    const asset: string | undefined = f.commissionAsset;
    if (asset === CONFIG.quoteAsset) {
      commissionUsdt += commission;
    } else if (asset === CONFIG.baseAsset) {
      commissionUsdt += commission * fp;
    } else {
      // BNB or other: approximate using the BNB-discount taker rate (0.075%)
      // applied to this fill's notional. Avoids an extra price lookup.
      commissionUsdt += fq * fp * 0.00075;
    }
  }
  return {
    fillPrice: qty > 0 ? quote / qty : 0,
    qtyBase: qty,
    quoteSpent: quote,
    commissionUsdt,
  };
}

export async function marketBuyUsdt(symbol: string, usdtAmount: number): Promise<FilledOrder> {
  const filters = await loadFilters(symbol);
  const price = await getPrice(symbol);
  const rawQty = usdtAmount / price;
  const qty = roundToStep(rawQty, filters.stepSize);

  if (qty < filters.minQty) {
    throw new Error(
      `Computed qty ${qty} below minQty ${filters.minQty} for ${symbol} (price ${price})`
    );
  }
  if (qty * price < filters.minNotional) {
    throw new Error(
      `Notional ${qty * price} below minNotional ${filters.minNotional} for ${symbol}`
    );
  }

  logger.info({ symbol, qty, estPrice: price, usdtAmount }, "submitting market BUY");
  const order: any = await client.marketBuy(symbol, qty);
  const fills = parseFills(order);
  logger.info({ orderId: order.orderId, ...fills }, "BUY filled");
  return { orderId: order.orderId, ...fills };
}

export async function marketSellAll(symbol: string, qtyBase: number): Promise<FilledOrder> {
  const filters = await loadFilters(symbol);
  const qty = roundToStep(qtyBase, filters.stepSize);
  if (qty < filters.minQty) {
    throw new Error(`Sell qty ${qty} below minQty ${filters.minQty}`);
  }
  logger.info({ symbol, qty }, "submitting market SELL");
  const order: any = await client.marketSell(symbol, qty);
  const fills = parseFills(order);
  logger.info({ orderId: order.orderId, ...fills }, "SELL filled");
  return { orderId: order.orderId, ...fills };
}
