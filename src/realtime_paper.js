// src/realtime_paper.js
const ccxt = require('ccxt');
const { env, SYMBOLS_ARR } = require('./config');
const { normalizeSymbolList } = require('./market_utils');
const { processRealtimeTick } = require('./bot');
const { loadState } = require('./state_store');
const watch = require('./rt_watch_store');

function tz(ts = Date.now(), tz = env.LOG_TZ) {
  const d = new Date(ts);
  return d.toLocaleString('sv-SE', { timeZone: tz, hour12: false });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const REFRESH_ACTIVE_MS = Number(env.RT_REFRESH_ACTIVE_MS || 5000);

async function getPrice(exchange, symbol) {
  try {
    const t = await exchange.fetchTicker(symbol);
    return Number(t.mark ?? t.last ?? t.close ?? t.info?.markPrice ?? t.info?.lastPrice);
  } catch (_) {
    return null;
  }
}

async function getActiveSymbols(exchange) {
  const state = await loadState();
  const positions = state?.paper?.positions || [];
  const raw = positions
    .filter(p => Number(p?.qty) > 0 && p?.symbol)
    .map(p => String(p.symbol));
  if (!raw.length) return [];
  const normalized = normalizeSymbolList(exchange, raw);
  return Array.from(new Set(normalized.filter(Boolean)));
}

function diffSets(prev = [], curr = []) {
  const A = new Set(prev), B = new Set(curr);
  return {
    added: curr.filter(x => !A.has(x)),
    removed: prev.filter(x => !B.has(x))
  };
}

async function loopOnce(exchange, symbols) {
  const ts = Date.now();
  for (const s of symbols) {
    const px = await getPrice(exchange, s);
    if (!Number.isFinite(px)) continue;
    const res = await processRealtimeTick(s, px, ts);
    if (Array.isArray(res?.paperExits) && res.paperExits.length) {
      for (const ev of res.paperExits) {
        const fracPct = Math.round((ev.fraction ?? 0) * 100);
        console.log(`[${tz()}] ⚡ RT EXIT ${s} ${ev.label} frac=${fracPct}% px=${ev.price} at=${ev.when} | eq=${res.equity}`);
      }
    }
  }
}

async function startRealtimePaperWatcher() {
  if (env.TRADE_ENABLED) {
    console.log('[rt] TRADE_ENABLED=true → exchange handles TP/SL; watcher disabled.');
    return;
  }
  if (!env.PAPER_REALTIME) {
    console.log('[rt] PAPER_REALTIME not enabled. Set PAPER_REALTIME=1 to start watcher.');
    return;
  }

  const ExchangeClass = ccxt[env.EXCHANGE_ID];
  if (!ExchangeClass) {
    console.error(`[rt] Exchange "${env.EXCHANGE_ID}" not supported by ccxt.`);
    return;
  }
  const exchange = new ExchangeClass({ enableRateLimit: true, options: { adjustForTimeDifference: true } });
  await exchange.loadMarkets();

  // initial sets
  let active = await getActiveSymbols(exchange);
  let manual = normalizeSymbolList(exchange, watch.getSymbols());
  let toPoll = computeSymbols(active, manual, watch.getMode());
  console.log(`[rt] watcher started | mode=${watch.getMode()} | poll=${env.RT_POLL_MS}ms | refreshActive=${REFRESH_ACTIVE_MS}ms`);
  console.log(`[rt] active=${active.join(', ') || '(none)'} | manual=${manual.join(', ') || '(none)'}`);

  let lastRefresh = 0;
  let lastVersion = watch.getVersion();

  while (true) {
    const now = Date.now();

    // refresh manual if changed
    if (watch.getVersion() !== lastVersion) {
      lastVersion = watch.getVersion();
      const prev = manual;
      manual = normalizeSymbolList(exchange, watch.getSymbols());
      const { added, removed } = diffSets(prev, manual);
      if (added.length)  console.log(`[rt] manual + ${added.join(', ')}`);
      if (removed.length) console.log(`[rt] manual - ${removed.join(', ')}`);
      console.log(`[rt] mode=${watch.getMode()} | manual now: ${manual.join(', ') || '(none)'}`);
    }

    // refresh active periodically
    if (now - lastRefresh >= REFRESH_ACTIVE_MS) {
      lastRefresh = now;
      try {
        const prev = active;
        active = await getActiveSymbols(exchange);
        const { added, removed } = diffSets(prev, active);
        if (added.length)  console.log(`[rt] active + ${added.join(', ')}`);
        if (removed.length) console.log(`[rt] active - ${removed.join(', ')}`);
      } catch (e) {
        console.error('[rt] refresh active symbols error:', e.message);
      }
    }

    // compute set to poll by mode
    toPoll = computeSymbols(active, manual, watch.getMode());

    try {
      if (toPoll.length) {
        await loopOnce(exchange, toPoll);
      }
    } catch (e) {
      console.error('[rt] loop error:', e.message);
    }

    await sleep(env.RT_POLL_MS);
  }
}

function computeSymbols(active, manual, mode) {
  switch (String(mode).toLowerCase()) {
    case 'manual': return manual.slice();
    case 'mix': {
      const s = new Set([...active, ...manual]);
      return Array.from(s);
    }
    case 'auto':
    default: return active.slice();
  }
}

module.exports = { startRealtimePaperWatcher };
