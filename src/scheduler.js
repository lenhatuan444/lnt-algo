// src/scheduler.js
const cron = require('node-cron');
const ccxt = require('ccxt');
const { env, SYMBOLS_ARR } = require('./config');
const { processSymbol } = require('./bot');

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function tzStamp(ts = Date.now(), tz = env.LOG_TZ) {
  const d = new Date(ts);
  const local = d.toLocaleString('sv-SE', { timeZone: tz, hour12: false });
  let offset = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(d);
    offset = (parts.find(p => p.type === 'timeZoneName')?.value || '').replace('GMT', 'UTC');
  } catch (_) {}
  return `${local}${offset ? ' ' + offset : ''} (${tz})`;
}
function utcIso(ts = Date.now()) { return new Date(ts).toISOString().replace('T', ' ').replace('Z', ' UTC'); }

function pLimit(max = 5) {
  let active = 0; const q = [];
  const next = () => {
    if (active >= max || q.length === 0) return;
    active++;
    const { fn, resolve, reject } = q.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
}

async function withRetry(fn, { retries = env.RETRIES, base = 250 } = {}) {
  let attempt = 0;
  const jitter = () => Math.floor(Math.random() * 100);
  while (true) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      const wait = base * (2 ** attempt) + jitter();
      await sleep(wait);
      attempt += 1;
    }
  }
}

async function pickTopSymbols(exchange, count, { quote = 'USDT' } = {}) {
  const tickers = await exchange.fetchTickers();
  return Object.entries(tickers)
    .filter(([sym, t]) => sym.endsWith(`/${quote}`) && t && typeof t.quoteVolume === 'number')
    .sort((a, b) => b[1].quoteVolume - a[1].quoteVolume)
    .slice(0, count)
    .map(([sym]) => sym);
}

// ---- helpers ----
function fmtReason(reason) {
  if (Array.isArray(reason)) return reason.join('|');
  if (reason == null) return '';
  if (typeof reason === 'string') return reason;
  try { return JSON.stringify(reason); } catch { return String(reason); }
}

async function runJob() {
  const startedAt = Date.now();
  const startMsg = `=== 4h Close Check @ ${tzStamp(startedAt)} (UTC: ${utcIso(startedAt)}) ===`;
  if (env.LOG_JSON) console.log(JSON.stringify({ level: 'info', msg: startMsg }));
  else console.log(`\n${startMsg}`);

  const ExchangeClass = ccxt[env.EXCHANGE_ID];
  if (!ExchangeClass) { console.error(`Exchange "${env.EXCHANGE_ID}" not supported by ccxt.`); return; }
  const exchange = new ExchangeClass({
    apiKey: env.API_KEY,
    secret: env.API_SECRET,
    enableRateLimit: true,
    options: { adjustForTimeDifference: true }
  });

  try {
    if ((env.POST_CLOSE_DELAY_SEC ?? 0) > 0) await sleep(env.POST_CLOSE_DELAY_SEC * 1000);
    await exchange.loadMarkets();

    if (exchange.timeframes && !exchange.timeframes[env.TIMEFRAME]) {
      console.error(`Timeframe "${env.TIMEFRAME}" có thể không được hỗ trợ bởi ${env.EXCHANGE_ID}.`);
    }

    let symbols = SYMBOLS_ARR;
    if (env.AUTOPICK_TOP > 0) {
      try {
        symbols = await pickTopSymbols(exchange, env.AUTOPICK_TOP, { quote: env.QUOTE });
        if (!symbols.length) throw new Error('auto-pick empty');
        if (!env.LOG_JSON) console.log(`[${tzStamp()}] Auto-pick top ${symbols.length} by volume: ${symbols.join(', ')}`);
      } catch (e) {
        console.error(`[${tzStamp()}] Auto-pick lỗi (${e.message}), fallback dùng SYMBOLS từ .env.`);
        symbols = SYMBOLS_ARR;
      }
    }

    const limit = pLimit(env.CONCURRENCY);
    const jobs = symbols.map((symbol) =>
      limit(() =>
        withRetry(() => processSymbol(exchange, symbol))
          .then((r) => {
            if (env.LOG_JSON) {
              // structured logs: keep payload as-is
              console.log(JSON.stringify({ level: 'info', symbol, ...r }));
              return;
            }

            const reasonText = fmtReason(r?.reason);

            if (r?.placed) {
              console.log(
                `[${tzStamp()}] ✅ ${symbol} ${r.side?.toUpperCase()} `
                + `qty=${r.qty} @~${r.entry} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} `
                + `(${reasonText})`
              );
            } else if (r?.simulated && r?.side) {
              console.log(
                `[${tzStamp()}] 🔎 ${symbol} signal ${r.side?.toUpperCase()} `
                + `qty=${r.qty} entry~${r.entry} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} `
                + `(${reasonText})`
              );
            } else if (r?.simulated) {
              console.log(`[${tzStamp()}] – ${symbol} simulated: ${reasonText}`);
            } else {
              console.log(`[${tzStamp()}] – ${symbol} skip: ${reasonText}`);
            }
          })
          // .catch(e => console.error(`[${tzStamp()}] ${symbol} error:`, e.message))
      )
    );

    await Promise.all(jobs);
  } catch (err) {
    console.error('Job error:', err);
  } finally {
    if (exchange.close) { try { await exchange.close(); } catch (_) {} }
  }
}

function schedule() {
  cron.schedule(env.CRON_EXPRESSION, () => { runJob(); }, { timezone: env.CRON_TZ });
  if (env.RUN_ON_START) runJob();
}

module.exports = { schedule, runJob };
