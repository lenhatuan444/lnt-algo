const ccxt = require('ccxt');
require('dotenv').config();

const { loadSymbols } = require('./universe');
const strat = require('./strategies/macd_dualema_rvol');
const { simulateOpenLong } = require('./paper_executor');
const { initMongo, createOrder } = require('./paper_db_mongo');

const DEFAULTS = {
  EXCHANGE_ID: 'binanceusdm',
  TIMEFRAME: '4h',
  MIDCAP_TOP_N: 100,
  SCAN_CANDLES: 600,
  SCAN_CONCURRENCY: 6,
  SCAN_RETRIES: 2,
};

const env = (k, d) => process.env[k] ?? DEFAULTS[k];
const envInt = (k) => parseInt(env(k), 10);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

async function mapLimit(items, limit, iteratee){
  const ret=new Array(items.length); let next=0, active=0;
  return new Promise((resolve)=>{
    const launch=()=>{
      if (next>=items.length && active===0) return resolve(ret);
      while (active<limit && next<items.length){
        const i=next++; active++;
        Promise.resolve(iteratee(items[i], i, items))
          .then(res=>{ret[i]=res;}).catch(err=>{ret[i]={error:err?.message||String(err)}})
          .finally(()=>{active--;launch();});
      }
    };
    launch();
  });
}

async function fetchOHLCVWithRetry(ex, symbol, timeframe, limit, retries){
  let last;
  for (let k=0;k<=retries;k++){
    try{
      const data = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
      if (Array.isArray(data) && data.length) return data;
      throw new Error('empty-ohlcv');
    }catch(e){ last=e; await sleep(500*(k+1)); }
  }
  throw last;
}

function fx(n,d=6){ return (n==null||!isFinite(n))? '' : Number(n).toFixed(d); }

async function main(){
  const exId = String(env('EXCHANGE_ID')).toLowerCase();
  const timeframe = String(env('TIMEFRAME'));
  if (!ccxt[exId]) { console.error('Unsupported exchange', exId); process.exit(1); }
  const exchange = new ccxt[exId]({ enableRateLimit:true, options:{ defaultType:'swap' } });
  await exchange.loadMarkets();
  await initMongo();

  const symbols = await loadSymbols(exchange, { TOP_N: envInt('MIDCAP_TOP_N') });
  if (!symbols.length){ console.error('[scan] No symbols loaded.'); process.exit(1); }
  console.log('[scan] Universe size:', symbols.length);

  const signal = strat.signalFromOHLCV;

  const res = await mapLimit(symbols, envInt('SCAN_CONCURRENCY'), async (symbol)=>{
    try{
      const ohlcv = await fetchOHLCVWithRetry(exchange, symbol, timeframe, envInt('SCAN_CANDLES'), envInt('SCAN_RETRIES'));
      const out = signal(ohlcv, {});
      if (out && out.action && out.action !== 'none'){
        return { ok:true, symbol, action:out.action, entry:out.entryPrice, stop:out.stopPrice, riskR:out.riskR };
      }
      return { ok:false, symbol, noSignal:true };
    }catch(e){
      return { ok:false, symbol, error:e.message||String(e) };
    }
  });

  const signals = res.filter(x=>x.ok && x.action==='buy');
  if (!signals.length){
    console.log('[scan] No BUY signals.');
    return;
  }

  for (const s of signals){
    const sim = await simulateOpenLong(exchange, s.symbol, { entryPrice:s.entry, stopPrice:s.stop, riskR:s.riskR }, { leverage:20 });
    if (!sim.ok) { console.log('[paper] Sim fail', s.symbol, sim.reason); continue; }
    const rec = await createOrder({
      symbol: sim.symbol, side:'long', leverage: sim.leverage,
      timeframe, strategyId:'macd_dualema_rvol', reason:'MACD buy signal',
      entryPrice: sim.entryPrice, stopPrice: sim.stopPrice, tpPrice: sim.takeProfit,
      qty: sim.qty, notional: sim.notional, margin: sim.margin, riskDollar: sim.riskDollar,
      equityAtOpen: Number(process.env.EQUITY || 10000), meta: {},
    });
    console.log('[paper][mongo] Opened', rec.symbol, 'id=', rec.id);
  }
}

main().catch(e=>{ console.error('[scan] Fatal:', e); process.exit(1); });
