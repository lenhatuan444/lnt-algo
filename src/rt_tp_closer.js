const ccxt = require('ccxt');
require('dotenv').config();
const { initMongo, listOpenOrders, closeOrder } = require('./paper_db_mongo');

const DEFAULTS = { EXCHANGE_ID:'binanceusdm', TIMEFRAME_MS: 4*60*60*1000, WATCH_LAST_MINUTES: 10, POLL_MS: 5000 };
const env = (k,d)=>process.env[k] ?? d;
const floorToFrame=(ts,ms)=>Math.floor(ts/ms)*ms;
const nextCloseTs=(now,ms)=>floorToFrame(now,ms)+ms;
const msUntilNextClose=(now,ms)=>nextCloseTs(now,ms)-now;
const withinLastMinutes=(now,ms,min)=>msUntilNextClose(now,ms)<=min*60*1000;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const exId = String(env('EXCHANGE_ID', DEFAULTS.EXCHANGE_ID)).toLowerCase();
  if (!ccxt[exId]) { console.error('Unsupported exchange', exId); process.exit(1); }
  const ex = new ccxt[exId]({ enableRateLimit:true, options:{ defaultType:'swap' } });
  await ex.loadMarkets(); await initMongo();

  const frameMs = Number(env('TIMEFRAME_MS', DEFAULTS.TIMEFRAME_MS));
  const lastMin = Number(env('WATCH_LAST_MINUTES', DEFAULTS.WATCH_LAST_MINUTES));
  const pollMs  = Number(env('POLL_MS', DEFAULTS.POLL_MS));
  const TIMEFRAME_STR = process.env.TIMEFRAME || '4h';
  const STRAT_ID = 'macd_dualema_rvol';

  while (true){
    const now=Date.now();
    if (!withinLastMinutes(now, frameMs, lastMin)){
      const left = msUntilNextClose(now, frameMs);
      const wake = Math.max(5*60*1000, left - lastMin*60*1000);
      await sleep(Math.min(wake, 10*60*1000));
      continue;
    }
    const endTs = nextCloseTs(now, frameMs);
    while (Date.now() < endTs){
      const opens = await listOpenOrders({ timeframe: TIMEFRAME_STR, strategyId: STRAT_ID });
      if (!opens.length){ await sleep(pollMs); continue; }
      const syms = Array.from(new Set(opens.map(o=>o.symbol)));
      const map = {};
      for (const s of syms){ try{ map[s]=await ex.fetchTicker(s); }catch(e){ } await sleep(200); }
      for (const o of opens){
        const t = map[o.symbol]; if (!t?.last) continue;
        const price = Number(t.last), tp = Number(o.tpPrice);
        if (o.side==='long' && price >= tp){
          const closed = await closeOrder(o.id, price, 'tp');
          if (closed) console.log('[TP] LONG', o.symbol, 'pnl$', closed.pnlUsd.toFixed(2));
        } else if (o.side!=='long' && price <= tp){
          const closed = await closeOrder(o.id, price, 'tp');
          if (closed) console.log('[TP] SHORT', o.symbol, 'pnl$', closed.pnlUsd.toFixed(2));
        }
      }
      await sleep(pollMs);
    }
  }
}
main().catch(e=>{ console.error('[tpwatch] Fatal:', e); process.exit(1); });
