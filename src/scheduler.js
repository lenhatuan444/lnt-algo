const cron = require('node-cron');
const ccxt = require('ccxt');
const { env, SYMBOLS_ARR } = require('./config');
const { processSymbol } = require('./bot');
const { normalizeSymbolList } = require('./market_utils');

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
    try { return await fn(); }
    catch (e) {
      if (attempt >= retries) throw e;
      const wait = base * (2 ** attempt) + jitter();
      await sleep(wait);
      attempt += 1;
    }
  }
}

async function runJob() {
  const startedAt = Date.now();
  const startMsg = `=== ${env.TIMEFRAME} Close Check @ ${tzStamp(startedAt)} (UTC: ${utcIso(startedAt)}) ===`;
  console.log(`\n${startMsg}`);

  const ExchangeClass = ccxt[env.EXCHANGE_ID];
  if (!ExchangeClass) { console.error(`Exchange "${env.EXCHANGE_ID}" not supported by ccxt.`); return; }
  const exchange = new ExchangeClass({
    apiKey: env.API_KEY,
    secret: env.API_SECRET,
    enableRateLimit: true,
    options: { adjustForTimeDifference: true }
  });

  try {
    await exchange.loadMarkets();

    let symbols = SYMBOLS_ARR;
    const normSymbols = normalizeSymbolList(exchange, symbols);
    for (let i = 0; i < symbols.length; i++) {
      if (symbols[i] !== normSymbols[i]) {
        console.log(`[${tzStamp()}] Map ${symbols[i]} -> ${normSymbols[i] || 'UNRESOLVED'}`);
      }
    }

    const limit = pLimit(env.CONCURRENCY);
    const jobs = normSymbols.map((symbol) =>
      limit(() =>
        withRetry(() => processSymbol(exchange, symbol))
          .then((r) => {
            const reasons = Array.isArray(r.reason) ? r.reason : (r.reason ? [r.reason] : []);
            if (r.placed) {
              console.log(`[${tzStamp()}] ✅ ${symbol} ${r.side?.toUpperCase()} qty=${r.qty} @~${r.entry} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} (${reasons.join('|')})`);
            } else if (r.paperEntry) {
              console.log(`[${tzStamp()}] 🧪 PAPER ENTRY ${symbol} ${r.side?.toUpperCase()} qty=${r.qty} @plan=${r.entry} exec~${r.entryExec} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} | eq=${r.equity} (${reasons.join('|')})`);
            } else if (Array.isArray(r.paperExits) && r.paperExits.length) {
              for (const ev of r.paperExits) {
                const fracPct = Math.round((ev.fraction ?? 0) * 100);
                console.log(`[${tzStamp()}] 🧪 PAPER EXIT  ${symbol} ${ev.label} frac=${fracPct}% px=${ev.price} at=${ev.when}`);
              }
            } else if (r.simulated) {
              if (r.side) {
                console.log(`[${tzStamp()}] 🔎 ${symbol} signal ${r.side?.toUpperCase()} qty=${r.qty} entry~${r.entry} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} (${reasons.join('|')})`);
              } else {
                console.log(`[${tzStamp()}] – ${symbol} simulated: ${reasons.join('|')}`);
              }
            } else {
              console.log(`[${tzStamp()}] – ${symbol} skip: ${reasons.join('|')}`);
            }
          })
          .catch(e => console.error(`[${tzStamp()}] ${symbol} error:`, e.message))
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
