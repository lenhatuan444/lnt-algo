# crypto-4h-scheduler

Runs **exactly at each 4-hour candle close** and prints the just-closed 4h close price for your configured symbols using **ccxt**.

## Quick start

```bash
# Node.js 18+
npm i

# Copy env template and edit as you like
cp .env.example .env

# Start
npm start
```

## Configure

Edit `.env`:

- `EXCHANGE_ID` — ccxt exchange id (default: `binance`)
- `SYMBOLS` — comma-separated list like `BTC/USDT,ETH/USDT,SOL/USDT`
- `TIMEFRAME` — default `4h`
- `POST_CLOSE_DELAY_SEC` — small buffer to avoid race at candle rollover
- `CRON_EXPRESSION` — default `0 0 */4 * * *` (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
- `CRON_TZ` — cron timezone (e.g., `UTC` or `Asia/Ho_Chi_Minh`)
- `RUN_ON_START` — run once immediately on start
- `LOG_JSON` — switch to JSON lines for easier log parsing

## Dev mode (optional)

```bash
npm run dev
```

## Notes

- We take the **penultimate** candle from `fetchOHLCV` as the just-closed candle.
- Keep `CRON_TZ=UTC` if you want to fire at exchange-aligned UTC 4h boundaries.
