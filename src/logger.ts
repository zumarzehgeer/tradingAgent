import pino from "pino";

// Default to pretty, human-readable logs. Production log aggregators that
// want raw JSON can opt in with LOG_JSON=true.
const json = process.env.LOG_JSON === "true";

// Defense-in-depth: if any object containing credentials or signed request
// metadata is ever passed to the logger (intentionally or via a thrown
// error from the exchange client), strip it before serialization.
const redact = {
  paths: [
    "*.APIKEY",
    "*.APISECRET",
    "*.apiKey",
    "*.apiSecret",
    "*.signature",
    "*.headers",
    "err.config",
    "err.request",
    "err.response.config",
    "err.response.request",
  ],
  remove: true,
};

export const logger = pino(
  json
    ? { redact }
    : {
        redact,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            // Tick logs intentionally pass structured fields (action, price,
            // ema*, rsi, daily*, unrealized*, entryPrice, reason) so JSON
            // aggregators can filter on them. Those same fields are already
            // baked into the human-readable msg, so hide them in pretty mode
            // to avoid double-printing. The list below covers tick + buy/sell
            // logs; any other field passed to the logger will still render.
            ignore:
              "pid,hostname,action,price,emaFast,emaSlow,rsi,dailyPnlUsdt,dailyTradeCount,entryPrice,unrealizedPnlUsdt,unrealizedPnlPct,reason,orderId,qty,fillPrice,qtyBase,qtyGross,baseCommission,quoteSpent,commissionUsdt,symbol,asset,knownAssets,src,consecutiveFailures",
            singleLine: true,
          },
        },
      }
);
