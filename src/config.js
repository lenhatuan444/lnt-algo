require('dotenv').config();

function toBool(v, def=false) {
  if (v === undefined) return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return ['1','true','yes','y','on'].includes(s);
}
function toNum(v, def=0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const env = {
  EXCHANGE_ID: process.env.EXCHANGE_ID || 'binanceusdm',
  API_KEY: process.env.API_KEY || '',
  API_SECRET: process.env.API_SECRET || '',

  TIMEFRAME: process.env.TIMEFRAME || '4h',
  CRON_EXPRESSION: process.env.CRON_EXPRESSION || '0 */4 * * *',
  CRON_TZ: process.env.CRON_TZ || 'UTC',
  LOG_TZ: process.env.LOG_TZ || 'Asia/Ho_Chi_Minh',
  POST_CLOSE_DELAY_SEC: toNum(process.env.POST_CLOSE_DELAY_SEC, 45),
  RUN_ON_START: toBool(process.env.RUN_ON_START, true),
  LOG_JSON: toBool(process.env.LOG_JSON, false),
  CONCURRENCY: toNum(process.env.CONCURRENCY, 6),
  RETRIES: toNum(process.env.RETRIES, 2),

  AUTOPICK_TOP: toNum(process.env.AUTOPICK_TOP, 10),
  QUOTE: process.env.QUOTE || 'USDT',
  SYMBOLS: process.env.SYMBOLS || 'BTC/USDT,ETH/USDT,SOL/USDT',

  TRADE_ENABLED: toBool(process.env.TRADE_ENABLED, false),
  LEVERAGE: toNum(process.env.LEVERAGE, 5),
  RISK_PCT: toNum(process.env.RISK_PCT, 1) / 100,

  DAILY_EMA: toNum(process.env.DAILY_EMA, 12),
  ATR_LEN: toNum(process.env.ATR_LEN, 14),
  ATR_MULT: toNum(process.env.ATR_MULT, 1.5),
  MACD_FAST: toNum(process.env.MACD_FAST, 12),
  MACD_SLOW: toNum(process.env.MACD_SLOW, 26),
  MACD_SIGNAL: toNum(process.env.MACD_SIGNAL, 9),
  VOL_LEN: toNum(process.env.VOL_LEN, 20),
  VOL_RATIO: toNum(process.env.VOL_RATIO, 1.2),
  TP1_RR: toNum(process.env.TP1_RR, 1.5),
  TP2_RR: toNum(process.env.TP2_RR, 3.0),

  EQUITY: toNum(process.env.EQUITY, 10000),
  SLIPPAGE_BPS: toNum(process.env.SLIPPAGE_BPS, 5),
};

const SYMBOLS_ARR = env.SYMBOLS.split(',').map(s => s.trim()).filter(Boolean);

module.exports = { env, SYMBOLS_ARR };
