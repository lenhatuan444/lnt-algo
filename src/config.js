// src/config.js
require('dotenv').config();
const { cleanEnv, str, num, bool } = require('envalid');

// Validate & load environment variables with sensible defaults
const env = cleanEnv(process.env, {
  EXCHANGE_ID:     str({ default: 'binance' }),
  SYMBOLS:         str({ default: 'BTC/USDT,ETH/USDT,SOL/USDT' }),
  TIMEFRAME:       str({ default: '4h' }),
  POST_CLOSE_DELAY_SEC: num({ default: 5 }),
  CRON_EXPRESSION: str({ default: '0 0 */4 * * *' }), // every 4h, at :00:00
  CRON_TZ:         str({ default: 'UTC' }),           // e.g., 'UTC' or 'Asia/Ho_Chi_Minh'
  RUN_ON_START:    bool({ default: true }),
  LOG_JSON:        bool({ default: false }),
});

// Derived config
const SYMBOLS_ARR = env.SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);

module.exports = { env, SYMBOLS_ARR };
