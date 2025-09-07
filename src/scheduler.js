// src/scheduler.js
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

async function pickTopSymbols(exchange, count, { quote = 'USDT' } = {}) {
  let tickers = {};
  try { tickers = await exchange.fetchTickers(); } catch (_) {}
  const markets = exchange.markets || {};

  const candidates = Object.values(markets).filter(m => {
    const okQuote = (m.quote === quote) || (m.settle === quote);
    return m.active !== false && okQuote && (m.swap || m.contract);
  });

  const withVol = candidates.map(m => {
    const t = tickers[m.symbol];
    const vol = (t && typeof t.quoteVolume === 'number') ? t.quoteVolume : 0;
    return { symbol: m.symbol, vol };
  });

  withVol.sort((a,b) => b.vol - a.vol);
  const top = (withVol.length ? withVol : candidates.map(m => ({symbol:m.symbol, vol:0}))).slice(0, count);
  return top.map(x => x.symbol);
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
        if (!env.LOG_JSON) console.log(
          `[${tzStamp()}] Auto-pick top ${symbols.length} by volume: ${symbols.join(', ')}`
        );
      } catch (e) {
        console.error(`[${tzStamp()}] Auto-pick lỗi (${e.message}), fallback dùng SYMBOLS từ .env.`);
        symbols = SYMBOLS_ARR;
      }
    }

    const normSymbols = normalizeSymbolList(exchange, symbols);
    for (let i = 0; i < symbols.length; i++) {
      if (symbols[i] !== normSymbols[i] && !env.LOG_JSON) {
        console.log(`[${tzStamp()}] Map ${symbols[i]} -> ${normSymbols[i] || 'UNRESOLVED'}`);
      }
    }

    const limit = pLimit(env.CONCURRENCY);
    const jobs = normSymbols.map((symbol) =>
      limit(() =>
        withRetry(() => processSymbol(exchange, symbol))
          .then((r) => {
            const sym = r.symbol || symbol;

            if (env.LOG_JSON) {
              // JSON logs (structured)
              if (r.placed) {
                console.log(JSON.stringify({ level: 'info', type: 'live_order', ...r }));
                return;
              }
              if (r.paperEntry) {
                console.log(JSON.stringify({
                  level: 'info', type: 'paper_entry',
                  symbol: sym, side: r.side, qty: r.qty, entry: r.entry,
                  entryExec: r.entryExec, stop: r.stop, tp1: r.tp1, tp2: r.tp2,
                  equity: r.equity, reason: r.reason
                }));
              }
              if (Array.isArray(r.paperExits) && r.paperExits.length) {
                for (const ev of r.paperExits) {
                  console.log(JSON.stringify({
                    level: 'info', type: 'paper_exit',
                    symbol: sym, label: ev.label,
                    fraction: ev.fraction, price: ev.price,
                    when: ev.when, equity: r.equity
                  }));
                }
              }
              if (!r.paperEntry && !(r.paperExits && r.paperExits.length)) {
                console.log(JSON.stringify({ level: 'info', type: 'simulated', ...r }));
              }
            } else {
              // Human-readable logs
              if (r.placed) {
                console.log(
                  `[${tzStamp()}] ✅ ${sym} ${r.side?.toUpperCase()} `
                  + `qty=${r.qty} @~${r.entry} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} `
                  + `(${(r.reason||[]).join('|')})`
                );
                return;
              }

              // 🧪 PAPER ENTRY
              if (r.paperEntry) {
                console.log(
                  `[${tzStamp()}] 🧪 PAPER ENTRY ${sym} ${r.side?.toUpperCase()} `
                  + `qty=${r.qty} @plan=${r.entry} exec~${r.entryExec} `
                  + `SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} | eq=${r.equity} `
                  + `(${(r.reason||[]).join('|')})`
                );
              }

              // 🧪 PAPER EXIT (may contain multiple events in the same bar)
              if (Array.isArray(r.paperExits) && r.paperExits.length) {
                for (const ev of r.paperExits) {
                  const fracPct = Math.round((ev.fraction ?? 0) * 100);
                  console.log(
                    `[${tzStamp()}] 🧪 PAPER EXIT  ${sym} ${ev.label} `
                    + `frac=${fracPct}% px=${ev.price} at=${ev.when} | eq=${r.equity}`
                  );
                }
              }

              // Fallback: simulated/no-signal formatting
              if (!r.paperEntry && !(r.paperExits && r.paperExits.length)) {
                if (r.simulated && r.side) {
                  console.log(
                    `[${tzStamp()}] 🔎 ${sym} signal ${r.side?.toUpperCase()} `
                    + `qty=${r.qty} entry~${r.entry} SL ${r.stop} TP1 ${r.tp1} TP2 ${r.tp2} `
                    + `(${(r.reason||[]).join('|')}) | eq=${r.equity}`
                  );
                } else if (r.simulated) {
                  console.log(`[${tzStamp()}] – ${sym} simulated: ${r.reason} | eq=${r.equity}`);
                } else {
                  console.log(`[${tzStamp()}] – ${sym} skip: ${r.reason}`);
                }
              }
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
