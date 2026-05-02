# tradingBot

Binance Spot BTC/USDT auto-trading bot. EMA 9/21 crossover with RSI 14 filter, $10/trade, hard 1% SL / 2% TP, $5 daily-loss kill switch.

> **Live trading risks real money. EMA-cross strategies underperform in choppy markets. Never run with funds you can't afford to lose.**

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env`:

1. Generate **testnet** keys at <https://testnet.binance.vision/> (Binance login required, but no KYC).
2. Paste them into `BINANCE_API_KEY` / `BINANCE_API_SECRET`.
3. Keep `BINANCE_TESTNET=true` for now.

## Run on testnet

```sh
npm start
```

You'll see one log line per minute showing the action (`BUY` / `SELL` / `HOLD`), the reason, and the current EMA/RSI values. Let it run for at least a few hours so you can confirm:

- Candles fetch without errors every 60s.
- Decisions and indicator values look sensible compared to the BTCUSDT chart on binance.com.
- If a cross fires, the bot opens a position, then exits on SL/TP or the next opposite cross.

The state file `state.json` shows the current open position (if any) and today's realized P&L. It's written atomically so a crash mid-tick won't corrupt it.

## Flip to live

Once you're confident:

1. At <https://www.binance.com/en/my/settings/api-management>, generate live API keys with **Spot Trading enabled** and **withdrawals disabled**. IP-restrict if possible.
2. In `.env`:
   - Set `BINANCE_TESTNET=false`
   - Replace `BINANCE_API_KEY` / `BINANCE_API_SECRET` with the live keys
3. Make sure your Binance account has at least ~$15 USDT free (a bit of buffer over the $10 trade size for fees + minNotional).
4. `npm start` again. Watch the first hour closely.

## Tuning

All knobs live in [src/config.ts](src/config.ts):

| Setting | Default | What it does |
|---|---|---|
| `tradeSizeUsdt` | `10` | USDT spent per BUY |
| `emaFast` / `emaSlow` | `9` / `21` | Crossover periods |
| `rsiPeriod` / `rsiOverbought` | `14` / `70` | Overbought guard |
| `stopLossPct` | `0.01` | Hard SL (1%) |
| `takeProfitPct` | `0.02` | Hard TP (2%) |
| `dailyLossCapUsdt` | `5` | Halts buys for the rest of the UTC day |
| `pollIntervalMs` | `60000` | Tick rate (matches 1m candles) |

## Stop the bot

`Ctrl+C`. The bot finishes the current tick and exits cleanly. **It does NOT close an open position on shutdown** — that's your call.

## Recovering after manual intervention

The bot expects `state.json` to match what's actually in your Binance account. If they desync, the bot halts at startup with a clear error rather than guessing.

**You manually sold the BTC on Binance:**
1. Stop the bot.
2. Delete `state.json`.
3. Restart. (You'll lose the entry-price record and today's accumulated P&L counter, but those are only useful if the bot itself sold the position.)

**The bot's position file got out of sync (e.g. a previous BUY succeeded but state didn't save):**
The startup guard catches this. Sell the orphaned BTC on Binance manually, then restart.

**Stale state (you ran the bot, it opened a position, you left it for >24h):**
The bot logs a warning at startup but still runs. If the entry price is way out of date, stop and start over: sell on Binance, delete `state.json`, restart.

## A note on first-tick behavior

If the bot starts up moments after an EMA cross fired, it will BUY immediately on its first tick — it doesn't wait for a fresh signal. This is intentional (the strategy acts on signals it sees), but if you don't want to trade an in-flight cross, wait until you can confirm no recent cross before starting. The bot only acts on **closed** candles, so cross signals are stable once the bot is running.

## Layout

```
src/
  index.ts      main loop
  config.ts     all tunables
  binance.ts    exchange client wrapper (testnet-aware)
  strategy.ts   pure EMA/RSI decision function
  risk.ts       SL/TP + daily-loss kill switch
  state.ts      atomic JSON persistence
  logger.ts     pino logger
```

## Out of scope (for now)

- Web dashboard, Telegram alerts, Docker — not in v1.
- Backtesting — the strategy module is a pure function, so adding one later is straightforward.
- Multi-pair, multi-strategy, leverage — single bot, single pair, Spot only.
