const ccxt = require('ccxt');
require('dotenv').config();
const { initMongo, listOpenOrders, closeOrder } = require('./paper_db_mongo');

const DEFAULTS = { EXCHANGE_ID:'binanceusdm', TIMEFRAME_STR:'4h', TIMEFRAME_MS:4*60*60*1000, SL_POST_WAIT_MIN:5, SL_POST_WINDOW_MIN:5, POLL_MS:5000, STRATEGY_ID:'macd_dualema_rvol' };
const env=(k,d)=>process.env[k] ?? d;
const floorToFrame=(ts,ms)=>Math.floor(ts/ms)*ms;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const exId=String(env('EXCHANGE_ID', DEFAULTS.EXCHANGE_ID)).toLowerCase();
  const frameMs=Number(env('TIMEFRAME_MS', DEFAULTS.TIMEFRAME_MS));
  const tfStr=String(env('TIMEFRAME', DEFAULTS.TIMEFRAME_STR));
  const stratId=String(env('STRATEGY_ID', DEFAULTS.STRATEGY_ID));
  const waitMin=Number(env('SL_POST_WAIT_MIN', DEFAULTS.SL_POST_WAIT_MIN));
  const winMin=Number(env('SL_POST_WINDOW_MIN', DEFAULTS.SL_POST_WINDOW_MIN));
  const pollMs=Number(env('POLL_MS', DEFAULTS.POLL_MS));

  if (!ccxt[exId]) { console.error('Unsupported exchange', exId); process.exit(1); }
  const ex = new ccxt[exId]({ enableRateLimit:true, options:{ defaultType:'swap' } });
  await ex.loadMarkets(); await initMongo();

  while (true){
    const now=Date.now();
    const lastClose=floorToFrame(now, frameMs);
    const start = lastClose + waitMin*60*1000;
    const end   = start + winMin*60*1000;

    if (now < start){ await sleep(Math.min(start-now, 10*60*1000)); continue; }
    if (now >= end){
      const nextStart = lastClose + frameMs + waitMin*60*1000;
      await sleep(Math.min(Math.max(5*60*1000, nextStart-now), 30*60*1000));
      continue;
    }

    while (Date.now() < end){
      const opens = await listOpenOrders({ timeframe: tfStr, strategyId: stratId });
      if (!opens.length){ await sleep(pollMs); continue; }
      const syms = Array.from(new Set(opens.map(o=>o.symbol)));
      const map = {};
      for (const s of syms){ try{ map[s]=await ex.fetchTicker(s); }catch(e){} await sleep(200); }
      for (const o of opens){
        const t = map[o.symbol]; if (!t?.last) continue;
        const price = Number(t.last), sl = Number(o.stopPrice);
        if (o.side==='long' && price <= sl){
          const closed = await closeOrder(o.id, price, 'sl');
          if (closed) console.log('[SL] LONG', o.symbol, 'pnl$', closed.pnlUsd.toFixed(2));
        } else if (o.side!=='long' && price >= sl){
          const closed = await closeOrder(o.id, price, 'sl');
          if (closed) console.log('[SL] SHORT', o.symbol, 'pnl$', closed.pnlUsd.toFixed(2));
        }
      }
      await sleep(pollMs);
    }
  }
}
main().catch(e=>{ console.error('[slwatch] Fatal:', e); process.exit(1); });
