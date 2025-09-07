const ccxt = require('ccxt');
const { env } = require('./config');
const { normalizeSymbolList } = require('./market_utils');
const { processRealtimeTick } = require('./bot');
const { loadState } = require('./state_store');
const watch = require('./rt_watch');

function tz(ts = Date.now(), tz = env.LOG_TZ) {
  const d = new Date(ts);
  return d.toLocaleString('sv-SE', { timeZone: tz, hour12: false });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getPrice(exchange, symbol) {
  try {
    const t = await exchange.fetchTicker(symbol);
    return Number(t.mark ?? t.last ?? t.close ?? t.info?.markPrice ?? t.info?.lastPrice);
  } catch (e) {
    return null;
  }
}

async function currentActiveSymbolsFromState() {
  try {
    const state = await loadState();
    const pos = state?.paper?.positions || [];
    const syms = [...new Set(pos.map(p => p.symbol))];
    return syms;
  } catch (_) {
    return [];
  }
}

function chooseWatchSet(activeSyms, manualSyms){
  const mode = String(env.RT_WATCH_MODE || 'active-only').toLowerCase();
  if (mode === 'manual') return manualSyms;
  if (mode === 'all-active+manual') return [...new Set([...activeSyms, ...manualSyms])];
  // default 'active-only'
  return activeSyms;
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

  // Build initial watch set
  const activeList = await currentActiveSymbolsFromState();
  const manualList = watch.get();
  const baseSymbols = chooseWatchSet(activeList, manualList);
  const symbols = normalizeSymbolList(exchange, baseSymbols);
  console.log(`[rt] Real-time PAPER watcher started for ${symbols.length} symbols, mode=${env.RT_WATCH_MODE}, poll=${env.RT_POLL_MS}ms`);

  while (true) {
    // refresh watch list each loop so manual/active updates take effect
    const active = await currentActiveSymbolsFromState();
    const manual = watch.get();
    const want = normalizeSymbolList(exchange, chooseWatchSet(active, manual));
    try { await loopOnce(exchange, want); } catch (e) { console.error('[rt] loop error:', e.message); }
    await sleep(env.RT_POLL_MS);
  }
}

module.exports = { startRealtimePaperWatcher };
