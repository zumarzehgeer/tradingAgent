// node-binance-api@1.x ships a .d.ts at dist/node-binance-api.d.ts but does
// not advertise it via the package "exports" map's "types" key. Under
// classic Node module resolution (module: "commonjs"), some TypeScript
// servers find the default export via package.json "typings" but fail to
// resolve named type re-exports. Restate the surface we use directly here
// so all imports are unambiguous regardless of resolution mode.

declare module "node-binance-api" {
  export type OrderSide = "BUY" | "SELL";
  export type OrderStatus =
    | "CANCELED"
    | "EXPIRED"
    | "FILLED"
    | "NEW"
    | "PARTIALLY_FILLED"
    | "PENDING_CANCEL"
    | "REJECTED";
  export type OrderType =
    | "LIMIT"
    | "MARKET"
    | "STOP"
    | "STOP_MARKET"
    | "TAKE_PROFIT"
    | "TAKE_PROFIT_MARKET"
    | "LIMIT_MAKER"
    | "TRAILING_STOP_MARKET"
    | "OCO";
  export type TimeInForce = "GTC" | "IOC" | "FOK" | "GTE_GTC" | "GTD";

  export interface Candle {
    openTime: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
    closeTime: number;
    quoteVolume?: string;
    trades: number;
    baseAssetVolume?: string;
    quoteAssetVolume: string;
  }

  export interface OrderFill {
    tradeId: number;
    price: string;
    qty: string;
    commission: string;
    commissionAsset: string;
  }

  export interface Order {
    clientOrderId: string;
    cummulativeQuoteQty: string;
    executedQty: string;
    fills?: OrderFill[];
    icebergQty?: string;
    isIsolated?: boolean;
    isWorking: boolean;
    orderId: number;
    orderListId: number;
    origQty: string;
    price: string;
    side: OrderSide;
    status: OrderStatus;
    stopPrice?: string;
    symbol: string;
    time: number;
    timeInForce: TimeInForce;
    transactTime?: number;
    type: OrderType;
    updateTime: number;
  }

  export interface IConstructorArgs {
    APIKEY: string;
    APISECRET: string;
    PRIVATEKEY?: string;
    PRIVATEKEYPASSWORD?: string;
    recvWindow?: number;
    useServerTime?: boolean;
    reconnect?: boolean;
    test?: boolean;
    demo?: boolean;
    hedgeMode?: boolean;
    httpsProxy?: string;
    socksProxy?: string;
    domain?: string;
    headers?: Record<string, unknown>;
    log?: (...args: unknown[]) => void;
    verbose?: boolean;
    keepAlive?: boolean;
  }

  export default class Binance {
    constructor(userOptions?: Partial<IConstructorArgs> | string);
    options(opt?: Partial<IConstructorArgs>): Binance;
    candlesticks(
      symbol: string,
      interval: string,
      params?: { limit?: number; startTime?: number; endTime?: number }
    ): Promise<Candle[]>;
    prices(symbol?: string): Promise<Record<string, string>>;
    balance(): Promise<Record<string, { available: string; onOrder: string } | undefined>>;
    exchangeInfo(): Promise<{
      symbols: Array<{
        symbol: string;
        filters: Array<Record<string, unknown>>;
      }>;
    }>;
    marketBuy(symbol: string, quantity: number, params?: Record<string, unknown>): Promise<Order>;
    marketSell(symbol: string, quantity: number, params?: Record<string, unknown>): Promise<Order>;
  }
}
