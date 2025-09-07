require('dotenv').config();

function bool(v, d=false){ if (v==null) return d; const s=String(v).trim().toLowerCase(); return ['1','true','yes','y','on'].includes(s); }
function num(v, d=0){ const n=Number(v); return Number.isFinite(n)?n:d; }

function sanitizeSid(s){
  const sid = (s || process.env.STRATEGY || 'default').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return sid || 'default';
}

const STRATEGY = sanitizeSid(process.env.STRATEGY);
const STRATEGIES_ARR = (process.env.STRATEGIES || STRATEGY).split(',').map(s => sanitizeSid(s)).filter(Boolean);

const env = {
  EXCHANGE_ID: process.env.EXCHANGE_ID || 'binanceusdm',
  API_KEY: process.env.API_KEY || '',
  API_SECRET: process.env.API_SECRET || '',
  TIMEFRAME: process.env.TIMEFRAME || '4h',
  QUOTE: process.env.QUOTE || 'USDT',
  SYMBOLS: process.env.SYMBOLS || 'BTC/USDT,ETH/USDT,SOL/USDT',
  CONCURRENCY: num(process.env.CONCURRENCY, 3),
  RETRIES: num(process.env.RETRIES, 2),
  RISK_PCT: num(process.env.RISK_PCT, 1.0),
  LEVERAGE: num(process.env.LEVERAGE, 5),
  EQUITY: num(process.env.EQUITY, 10000),
  SLIPPAGE_BPS: num(process.env.SLIPPAGE_BPS, 10),
  CRON_EXPRESSION: process.env.CRON_EXPRESSION || '1 */4 * * *',
  CRON_TZ: process.env.CRON_TZ || 'UTC',
  LOG_TZ: process.env.LOG_TZ || 'Asia/Ho_Chi_Minh',
  RUN_ON_START: bool(process.env.RUN_ON_START, true),
  AUTOPICK_TOP: num(process.env.AUTOPICK_TOP, 0),

  // Realtime watcher
  PAPER_REALTIME: bool(process.env.PAPER_REALTIME, false),
  RT_POLL_MS: num(process.env.RT_POLL_MS, 5000),
  RT_WATCH_MODE: (process.env.RT_WATCH_MODE || 'active-only').toLowerCase(), // active-only | manual | all-active+manual

  // API
  API_PORT: num(process.env.API_PORT, 8080),
  BACKTEST_DIR: process.env.BACKTEST_DIR,
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  API_DEFAULT_LIMIT: num(process.env.API_DEFAULT_LIMIT, 100),
  API_MAX_LIMIT: num(process.env.API_MAX_LIMIT, 1000),

  // Mongo
  MONGO_ENABLE: bool(process.env.MONGO_ENABLE, false),
  MONGO_URI: process.env.MONGO_URI || 'mongodb://localhost:27017',
  MONGO_DB: process.env.MONGO_DB || 'lnt_algo',
  MONGO_NO_CSV: bool(process.env.MONGO_NO_CSV, false),

  // Base names for collections
  MONGO_COLL_ENTRIES_BASE: process.env.MONGO_COLL_ENTRIES_BASE || 'paper_entries',
  MONGO_COLL_EXITS_BASE: process.env.MONGO_COLL_EXITS_BASE || 'paper_exits',
  MONGO_COLL_TRADES_BASE: process.env.MONGO_COLL_TRADES_BASE || 'paper_trades',
  MONGO_COLL_EQUITY_BASE: process.env.MONGO_COLL_EQUITY_BASE || 'paper_equity',
  MONGO_COLL_POSITIONS_BASE: process.env.MONGO_COLL_POSITIONS_BASE || 'paper_positions',
  MONGO_COLL_STATE_BASE: process.env.MONGO_COLL_STATE_BASE || 'bot_state',
};

const SYMBOLS_ARR = env.SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);

function collFor(base, sid){
  const s = sanitizeSid(sid);
  switch(base){
    case 'entries': return `${env.MONGO_COLL_ENTRIES_BASE}__${s}`;
    case 'exits': return `${env.MONGO_COLL_EXITS_BASE}__${s}`;
    case 'trades': return `${env.MONGO_COLL_TRADES_BASE}__${s}`;
    case 'equity': return `${env.MONGO_COLL_EQUITY_BASE}__${s}`;
    case 'positions': return `${env.MONGO_COLL_POSITIONS_BASE}__${s}`;
    case 'state': return `${env.MONGO_COLL_STATE_BASE}__${s}`;
    default: return `${base}__${s}`;
  }
}

function fileFor(kind, sid) {
  const s = sanitizeSid(sid);
  const prefix = `${s}_`;
  switch(kind){
    case 'entries': return prefix + 'paper_entries.csv';
    case 'exits': return prefix + 'paper_exits.csv';
    case 'trades': return prefix + 'paper_trades.csv';
    case 'equity': return prefix + 'paper_equity.csv';
    case 'positions': return prefix + 'paper_positions.csv';
    case 'state': return `bot_state__${s}.json`;
    case 'rtwatch': return `rt_watch__${s}.json`;
    default: return prefix + `${kind}.csv`;
  }
}

module.exports = { env, SYMBOLS_ARR, STRATEGY, STRATEGIES_ARR, sanitizeSid, collFor, fileFor };
