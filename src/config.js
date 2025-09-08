// src/config.js
require('dotenv').config();

function parseList(str, sep = ',') {
  return String(str || '')
    .split(sep)
    .map(s => s.trim())
    .filter(Boolean);
}

const env = {
  // ===== MongoDB =====
  MONGO_ENABLE: String(process.env.MONGO_ENABLE || '0') === '1',
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017',
  MONGO_DB: process.env.MONGO_DB || 'lnt_algo',
  MONGO_COLL_ENTRIES: process.env.MONGO_COLL_ENTRIES || 'paper_entries',
  MONGO_COLL_EXITS: process.env.MONGO_COLL_EXITS || 'paper_exits',
  MONGO_COLL_TRADES: process.env.MONGO_COLL_TRADES || 'paper_trades',
  MONGO_COLL_EQUITY: process.env.MONGO_COLL_EQUITY || 'paper_equity',
  MONGO_COLL_POSITIONS: process.env.MONGO_COLL_POSITIONS || 'paper_positions',
  MONGO_COLL_STATE: process.env.MONGO_COLL_STATE || 'bot_state',

  // General
  EXCHANGE_ID: process.env.EXCHANGE_ID || 'binanceusdm',
  QUOTE: process.env.QUOTE || 'USDT',
  TIMEFRAME: process.env.TIMEFRAME || '4h',
  CRON_EXPRESSION: process.env.CRON_EXPRESSION || '5 */4 * * *', // 4h+5m
  CRON_TZ: process.env.CRON_TZ || 'UTC',
  LOG_TZ: process.env.LOG_TZ || 'Asia/Ho_Chi_Minh',
  RUN_ON_START: String(process.env.RUN_ON_START || '1') === '1',
  POST_CLOSE_DELAY_SEC: Number(process.env.POST_CLOSE_DELAY_SEC || 5),

  // Trading settings
  TRADE_ENABLED: String(process.env.TRADE_ENABLED || 'false').toLowerCase() === 'true',
  LEVERAGE: Number(process.env.LEVERAGE || 2),
  PAPER_USE_LEVERAGE: Number(process.env.PAPER_USE_LEVERAGE || 0),
  RISK_PCT: Number(process.env.RISK_PCT || 1),
  SLIPPAGE_BPS: Number(process.env.SLIPPAGE_BPS || 0),
  EQUITY: Number(process.env.EQUITY || 10000),
  EQUITY_CCY: process.env.EQUITY_CCY || 'USDT',

  // Concurrency / retry
  CONCURRENCY: Math.max(1, Number(process.env.CONCURRENCY || 4)),
  RETRIES: Math.max(0, Number(process.env.RETRIES || 2)),

  // Autopick
  AUTOPICK_TOP: Number(process.env.AUTOPICK_TOP || 0),

  // Logging
  LOG_JSON: String(process.env.LOG_JSON || '0') === '1',

  // API
  API_PORT: Number(process.env.API_PORT || 8080),
  BACKTEST_DIR: process.env.BACKTEST_DIR,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  API_DEFAULT_LIMIT: Number(process.env.API_DEFAULT_LIMIT || 100),
  API_MAX_LIMIT: Number(process.env.API_MAX_LIMIT || 1000),

  // Strategy selection
  STRATEGY: process.env.STRATEGY || 'default',
  BB_PERIOD: Number(process.env.BB_PERIOD || 20),
  BB_STDDEV: Number(process.env.BB_STDDEV || 2),
  RSI_LEN: Number(process.env.RSI_LEN || 14),
  RSI_OVERSOLD: Number(process.env.RSI_OVERSOLD || 30),
  RSI_OVERBOUGHT: Number(process.env.RSI_OVERBOUGHT || 70),
  MR_TP_RR: Number(process.env.MR_TP_RR || 1.0),
  DONCHIAN_LEN: Number(process.env.DONCHIAN_LEN || 55),
  ATR_LEN: Number(process.env.ATR_LEN || 14),
  ATR_MULT: Number(process.env.ATR_MULT || 2),
  TP1_RR: Number(process.env.TP1_RR || 1),
  TP2_RR: Number(process.env.TP2_RR || 2),

  
  // Exit profiles & engine
  EXIT_MODE: (process.env.EXIT_MODE || 'auto').toLowerCase(),
  EXIT_PROFILE_MAP: process.env.EXIT_PROFILE_MAP || '',
  TP_ON_TOUCH: Number(process.env.TP_ON_TOUCH || 1),
  SL_ON_TOUCH: Number(process.env.SL_ON_TOUCH || 1),
  FULL_TP_ON_TP1: Number(process.env.FULL_TP_ON_TP1 || 1),

  // Profile params
  ATR_TP_MULT: Number(process.env.ATR_TP_MULT || 2.0),
  CHANDELIER_K: Number(process.env.CHANDELIER_K || 3.5),
  HARD_TP_RR_TREND: Number(process.env.HARD_TP_RR_TREND || 5.0),
  TIME_STOP_BARS: Number(process.env.TIME_STOP_BARS || 6),
  MR_TP_RR: Number(process.env.MR_TP_RR || 1.0),

  // Adaptive TP for default strategy
  ADAPT_TP_RR: Number(process.env.ADAPT_TP_RR || 1),
  TP_PENETRATION_BPS: Number(process.env.TP_PENETRATION_BPS || 0),

  // Real-time paper exits
  PAPER_REALTIME: Number(process.env.PAPER_REALTIME || 0),
  PAPER_XLSX_AUTO: Number(process.env.PAPER_XLSX_AUTO || 0),
  PAPER_XLSX_EXPORT_INTERVAL_MS: Number(process.env.PAPER_XLSX_EXPORT_INTERVAL_MS || 60000),
  PAPER_XLSX_BASENAME: process.env.PAPER_XLSX_BASENAME || 'paper',
  PAPER_XLSX_SNAPSHOTS: Number(process.env.PAPER_XLSX_SNAPSHOTS || 0),
  RT_POLL_MS: Math.max(200, Number(process.env.RT_POLL_MS || 1000)),

  // Keys (optional for live)
  API_KEY: process.env.API_KEY,
  API_SECRET: process.env.API_SECRET,
};

const SYMBOLS_ARR = parseList(process.env.SYMBOLS || 'BTC/USDT,ETH/USDT,SOL/USDT');

module.exports = { env, SYMBOLS_ARR };
