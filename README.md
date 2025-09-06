# Crypto 4H Bot (EMA1D + VWAP + MACD + ATR)

Scanner 4H + Trading bot (optional) + Backtester (xuất Excel).

## Cài đặt

```bash
npm i
# hoặc
npm i ccxt dotenv node-cron xlsx
cp .env.example .env
```

Điền API key nếu bật trade.

## Scheduler (quét nến 4h + tín hiệu + (tuỳ chọn) đặt lệnh)

```bash
npm run scheduler
```

- `TRADE_ENABLED=false` → chỉ log tín hiệu, **không** đặt lệnh.
- `TRADE_ENABLED=true` → đặt lệnh futures (USDT-M) với SL/TP1/TP2.

## Backtest (xuất Excel)

```bash
npm run backtest
# hoặc:
node src/backtest.js --symbol BTC/USDT --from 2024-01-01 --to 2025-09-01   --exchange binance --timeframe 4h --equity 10000 --risk 1 --slipbps 5
```

Kết quả: `backtest_outputs/` (Excel `trades`, `equity_curve`, `summary`).

## Cấu trúc

```
src/
  backtest.js
  bot.js
  config.js
  indicators.js
  scheduler.js
  strategy.js
  trader.js
  index.js
```
