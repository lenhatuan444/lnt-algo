// Backtest 4H strategy with slippage, Sharpe, Sortino, CAGR.
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');
require('dotenv').config();
const { env } = require('./config');

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nxt = argv[i + 1];
      if (!nxt || nxt.startsWith('--')) out[key] = true;
      else { out[key] = nxt; i++; }
    }
  }
  return out;
}
const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));
const fmt = (ts) => new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- Indicators (inline minimal) ---
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let emaVal = null, seed = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (emaVal == null) {
      seed += v; cnt++;
      out.push(cnt === period ? (emaVal = seed / period) : null);
    } else {
      emaVal = v * k + emaVal * (1 - k);
      out.push(emaVal);
    }
  }
  return out;
}
function sma(values, period) {
  const out = [];
  let sum = 0, q = [];
  for (const v of values) {
    q.push(v); sum += v;
    if (q.length > period) sum -= q.shift();
    out.push(q.length === period ? sum / period : null);
  }
  return out;
}
function macd(values, fast=12, slow=26, signal=9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (emaFast[i]==null||emaSlow[i]==null)?null:(emaFast[i]-emaSlow[i]));
  const base = macdLine.map(v => v==null?0:v);
  const signalLine = ema(base, signal).map((v,i)=> macdLine[i]==null?null:v);
  const hist = macdLine.map((v,i)=> (v==null||signalLine[i]==null)?null:(v - signalLine[i]));
  return { macdLine, signalLine, hist };
}
function atr(ohlcv, period=14) {
  const trs = [];
  for (let i = 0; i < ohlcv.length; i++) {
    const prevClose = i > 0 ? ohlcv[i-1][4] : ohlcv[i][4];
    const high = ohlcv[i][2], low = ohlcv[i][3];
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const out = [];
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    const tr = trs[i];
    if (i < period) { sum += tr; out.push(null); continue; }
    if (i === period) { sum += tr; out.push(sum / (period + 1)); continue; }
    const prevAtr = out[out.length - 1];
    out.push((prevAtr * (period - 1) + tr) / period);
  }
  return out;
}
function dailyVWAP(ohlcv) {
  const out = [];
  let dayKey = null, cumPV = 0, cumV = 0;
  for (const [ts, , high, low, close, vol] of ohlcv) {
    const typical = (high + low + close) / 3;
    const dk = Math.floor(ts / 86400000);
    if (dayKey === null || dk !== dayKey) { dayKey = dk; cumPV = 0; cumV = 0; }
    cumPV += typical * (vol || 0);
    cumV  += (vol || 0);
    out.push(cumV > 0 ? (cumPV / cumV) : null);
  }
  return out;
}

// --- Data helpers ---
async function fetchOHLCVRange(exchange, symbol, timeframe, sinceMs, toMs) {
  const tfSec = exchange.parseTimeframe(timeframe);
  const tfMs = tfSec * 1000;
  const res = [];
  let since = sinceMs;
  while (true) {
    const batch = await exchange.fetchOHLCV(symbol, timeframe, since, 1000);
    if (!batch || batch.length === 0) break;
    for (const row of batch) {
      const ts = row[0];
      if (res.length && ts <= res[res.length - 1][0]) continue;
      if (ts > toMs) break;
      res.push(row);
    }
    if (batch.length < 1000) break;
    since = batch[batch.length - 1][0] + tfMs;
    if (since >= toMs) break;
    if (exchange.rateLimit) await sleep(exchange.rateLimit);
  }
  return res;
}
function pickDailyIdxFor4h(ts4hOpen, daily) {
  let k = -1;
  for (let i = 0; i < daily.length - 1; i++) {
    const tsOpen = daily[i][0];
    const tsOpenNext = daily[i+1][0];
    if (ts4hOpen >= tsOpen && ts4hOpen < tsOpenNext) { k = i; break; }
  }
  if (k === -1) k = daily.length - 2;
  return k;
}

// --- Metrics helpers ---
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x-m)*(x-m)));
  return Math.sqrt(v);
}
function downsideDeviation(arr, mar=0) {
  if (!arr.length) return 0;
  const downs = arr.map(x => Math.min(0, x - mar));
  const v = mean(downs.map(x => x*x));
  return Math.sqrt(v);
}
function profitFactor(trades) {
  const gains = trades.filter(t=>t.pnl>0).reduce((a,b)=>a+b.pnl,0);
  const losses = trades.filter(t=>t.pnl<0).reduce((a,b)=>a+Math.abs(b.pnl),0);
  return losses > 0 ? (gains / losses) : (gains > 0 ? Infinity : 0);
}
function maxDrawdown(equity) {
  let peak = -Infinity, mdd = 0;
  for (const e of equity) { peak = Math.max(peak, e); mdd = Math.max(mdd, peak - e); }
  return mdd;
}

// --- Simulator with slippage & partial exits ---
function simulateTrade(p, bars, startIndex, slipBps=0) {
  const slip = Math.max(0, Number(slipBps) || 0) / 10000;
  const { side, entry, stop, tp1, tp2 } = p;
  const sideSign = side === 'buy' ? 1 : -1;

  const entryExec = side === 'buy' ? entry * (1 + slip) : entry * (1 - slip);

  let remaining = 1.0;
  const exits = [];
  let tookTP1 = false;
  let lastIndex = startIndex;

  for (let j = startIndex; j < bars.length; j++) {
    const [, , h, l] = bars[j];
    lastIndex = j;

    if (side === 'buy') {
      if (!tookTP1) {
        if (l <= stop) {
          const px = stop * (1 - slip);
          exits.push({ fraction: remaining, price: px, label: 'SL', index: j });
          remaining = 0; break;
        }
        if (h >= tp1) {
          const f = 0.5;
          const px = tp1 * (1 - slip);
          exits.push({ fraction: f, price: px, label: 'TP1', index: j });
          remaining -= f; tookTP1 = true;
          if (remaining <= 0) break;
          continue;
        }
      } else {
        if (l <= entry) {
          const px = entry * (1 - slip);
          exits.push({ fraction: remaining, price: px, label: 'BE', index: j });
          remaining = 0; break;
        }
        if (h >= tp2) {
          const px = tp2 * (1 - slip);
          exits.push({ fraction: remaining, price: px, label: 'TP2', index: j });
          remaining = 0; break;
        }
      }
    } else { // short
      if (!tookTP1) {
        if (h >= stop) {
          const px = stop * (1 + slip);
          exits.push({ fraction: remaining, price: px, label: 'SL', index: j });
          remaining = 0; break;
        }
        if (l <= tp1) {
          const f = 0.5;
          const px = tp1 * (1 + slip);
          exits.push({ fraction: f, price: px, label: 'TP1', index: j });
          remaining -= f; tookTP1 = true;
          if (remaining <= 0) break;
          continue;
        }
      } else {
        if (h >= entry) {
          const px = entry * (1 + slip);
          exits.push({ fraction: remaining, price: px, label: 'BE', index: j });
          remaining = 0; break;
        }
        if (l <= tp2) {
          const px = tp2 * (1 + slip);
          exits.push({ fraction: remaining, price: px, label: 'TP2', index: j });
          remaining = 0; break;
        }
      }
    }
  }

  if (remaining > 0) {
    const last = bars[bars.length - 1][4];
    const px = side === 'buy' ? last * (1 - slip) : last * (1 + slip);
    exits.push({ fraction: remaining, price: px, label: 'MKT_EOD', index: bars.length - 1 });
    lastIndex = bars[bars.length - 1][0];
    remaining = 0;
  }

  const perUnitPnl = exits.reduce((sum, ex) => {
    const frac = ex.fraction;
    const leg = sideSign * (ex.price - entryExec);
    return sum + frac * leg;
  }, 0);

  return {
    exitIndex: exits[exits.length - 1].index,
    perUnitPnl,
    exits,
    entryExec,
    hits: exits.map(x => x.label)
  };
}

// --- Main ---
async function main() {
  const args = parseArgs();
  const symbol     = args.symbol || env.SYMBOL || 'BTC/USDT';
  const exchangeId = args.exchange || env.EXCHANGE_ID || 'binance';
  const timeframe  = args.timeframe || env.TIMEFRAME || '4h';
  const fromMs     = args.from ? toMs(args.from) : (Date.now() - 365*24*3600*1000);
  const toMs       = args.to ? toMs(args.to) : Date.now();
  const startingEq = Number(args.equity || env.EQUITY || 10000);
  const riskPct    = Number(args.risk || (env.RISK_PCT*100) || 1) / 100.0;
  const slipBps    = Number(args.slipbps || env.SLIPPAGE_BPS || 0);

  const MACD_FAST   = Number(env.MACD_FAST || 12);
  const MACD_SLOW   = Number(env.MACD_SLOW || 26);
  const MACD_SIGNAL = Number(env.MACD_SIGNAL || 9);
  const DAILY_EMA   = Number(env.DAILY_EMA || 12);
  const ATR_LEN     = Number(env.ATR_LEN || 14);
  const ATR_MULT    = Number(env.ATR_MULT || 1.5);
  const VOL_LEN     = Number(env.VOL_LEN || 20);
  const VOL_RATIO   = Number(env.VOL_RATIO || 1.2);
  const TP1_RR      = Number(env.TP1_RR || 1.5);
  const TP2_RR      = Number(env.TP2_RR || 3.0);

  const ExchangeClass = ccxt[exchangeId];
  if (!ExchangeClass) { console.error(`Exchange ${exchangeId} not supported.`); process.exit(1); }
  const ex = new ExchangeClass({ enableRateLimit: true, options: { adjustForTimeDifference: true } });

  console.log(`Backtesting ${symbol} ${timeframe} from ${fmt(fromMs)} to ${fmt(toMs)} on ${exchangeId} (slip=${slipBps}bps)...`);
  await ex.loadMarkets();

  const h4 = await fetchOHLCVRange(ex, symbol, timeframe, fromMs, toMs);
  const d1 = await fetchOHLCVRange(ex, symbol, '1d', fromMs - 10*86400000, toMs + 86400000);
  if (h4.length < 200 || d1.length < 50) { console.error('Not enough data.'); process.exit(1); }

  const closes = h4.map(r=>r[4]);
  const vols   = h4.map(r=>r[5]);
  const { hist } = macd(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL);
  const atr4h   = atr(h4, ATR_LEN);
  const vwap4h  = dailyVWAP(h4);
  const volSMA  = sma(vols, VOL_LEN);

  const dCloses = d1.map(r=>r[4]);
  const emaD    = ema(dCloses, DAILY_EMA);

  const trades = [];
  const equityCurve = [];
  let equity = startingEq;

  for (let i = 50; i < h4.length - 2; i++) {
    const tsOpen = h4[i][0];
    const close = h4[i][4];

    const macdUp   = hist[i-1] != null && hist[i] != null && hist[i-1] <= 0 && hist[i] > 0;
    const macdDown = hist[i-1] != null && hist[i] != null && hist[i-1] >= 0 && hist[i] < 0;

    const volOk = volSMA[i] != null ? (vols[i] >= volSMA[i] * VOL_RATIO) : true;
    const vwap  = vwap4h[i];
    const aboveVWAP = vwap != null ? (close > vwap) : true;
    const belowVWAP = vwap != null ? (close < vwap) : true;

    const dailyIdx = pickDailyIdxFor4h(tsOpen, d1);
    if (dailyIdx < 1) continue;
    const dailyOkUp   = (emaD[dailyIdx] != null) && (dCloses[dailyIdx] > emaD[dailyIdx]);
    const dailyOkDown = (emaD[dailyIdx] != null) && (dCloses[dailyIdx] < emaD[dailyIdx]);

    const longOK  = dailyOkUp && aboveVWAP && macdUp && volOk;
    const shortOK = dailyOkDown && belowVWAP && macdDown && volOk;
    if (!longOK && !shortOK) continue;

    const atrNow = atr4h[i];
    if (!atrNow || atrNow <= 0) continue;

    const side = longOK ? 'buy' : 'sell';
    const entry = close;
    const stop  = side === 'buy' ? (entry - atrNow * ATR_MULT) : (entry + atrNow * ATR_MULT);
    const riskPerUnit = Math.abs(entry - stop);
    if (riskPerUnit <= 0) continue;

    const risk$ = equity * riskPct;
    const qty = risk$ / riskPerUnit;

    const tp1 = side === 'buy' ? (entry + riskPerUnit * TP1_RR) : (entry - riskPerUnit * TP1_RR);
    const tp2 = side === 'buy' ? (entry + riskPerUnit * TP2_RR) : (entry - riskPerUnit * TP2_RR);

    const sim = simulateTrade({ side, entry, stop, tp1, tp2 }, h4, i + 1, slipBps);
    const pnl = sim.perUnitPnl * qty;

    equity += pnl;
    equityCurve.push(equity);

    const entryEquity = equity - pnl;
    trades.push({
      symbol,
      timeframe,
      side,
      entryTime: fmt(h4[i][0]),
      entryPrice: entry,
      entryExec: +sim.entryExec.toFixed(6),
      exitTime: fmt(h4[sim.exitIndex][0]),
      exitPriceExecWeighted: +(
        sim.exits.reduce((s, e) => s + e.fraction * e.price, 0)
      ).toFixed(6),
      qty,
      risk$: +risk$.toFixed(4),
      pnl: +pnl.toFixed(4),
      retPct: +((pnl / Math.max(1e-9, entryEquity)) * 100).toFixed(4),
      hits: sim.hits.join('|'),
      volOk,
      vwap: Number.isFinite(vwap) ? vwap : null,
      dailyClose: dCloses[dailyIdx],
      dailyEMA: emaD[dailyIdx],
      atr: atrNow,
      tp1, tp2, stop,
      slipBps
    });
  }

  const wins = trades.filter(t=>t.pnl>0).length;
  const losses = trades.filter(t=>t.pnl<0).length;
  const totalTrades = trades.length;
  const pf = profitFactor(trades);
  const mdd = maxDrawdown(equityCurve);
  const net = equity - startingEq;

  // Returns per trade (decimal)
  const returns = trades.map(t => (t.retPct || 0) / 100);
  const periodYears = Math.max(1/365, (toMs(toMs) ? 0 : 0) + ((toMs - fromMs) / (365 * 24 * 3600 * 1000))); // ensure >0
  const tradesPerYear = totalTrades > 0 ? (totalTrades / periodYears) : 0;

  const sh = (std(returns) > 0) ? (mean(returns) / std(returns)) : 0;
  const sharpeAnnual = sh * Math.sqrt(Math.max(1, tradesPerYear));

  const dd = downsideDeviation(returns, 0);
  const sortino = dd > 0 ? (mean(returns) / dd) : 0;
  const sortinoAnnual = sortino * Math.sqrt(Math.max(1, tradesPerYear));

  const CAGR = Math.pow(Math.max(1e-9, equity / Math.max(1e-9, startingEq)), 1 / periodYears) - 1;

  const summary = {
    symbol, timeframe,
    from: fmt(fromMs), to: fmt(toMs),
    trades: totalTrades, wins, losses,
    winratePct: +(totalTrades ? (wins/totalTrades*100) : 0).toFixed(2),
    profitFactor: Number.isFinite(pf) ? +pf.toFixed(2) : pf,
    maxDrawdown$: +mdd.toFixed(2),
    startEquity$: +startingEq.toFixed(2),
    endEquity$: +equity.toFixed(2),
    netPnL$: +net.toFixed(2),
    periodYears: +periodYears.toFixed(4),
    tradesPerYear: +tradesPerYear.toFixed(2),
    sharpeAnnual: +sharpeAnnual.toFixed(3),
    sortinoAnnual: +sortinoAnnual.toFixed(3),
    CAGR: +CAGR.toFixed(4),
    slippageBpsPerFill: slipBps
  };

  // Write Excel/CSV
  const outDir = path.join(process.cwd(), 'backtest_outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  const base = `backtest_${symbol.replace('/','-')}_${timeframe}_${stamp}`;

  let wroteXlsx = false;
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();

    const tradesSheet = XLSX.utils.json_to_sheet(trades);
    XLSX.utils.book_append_sheet(wb, tradesSheet, 'trades');

    const equityRows = equityCurve.map((e, i) => ({ index: i+1, equity: e }));
    const equitySheet = XLSX.utils.json_to_sheet(equityRows);
    XLSX.utils.book_append_sheet(wb, equitySheet, 'equity_curve');

    const summarySheet = XLSX.utils.json_to_sheet([summary]);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'summary');

    const xlsxPath = path.join(outDir, `${base}.xlsx`);
    XLSX.writeFile(wb, xlsxPath);
    wroteXlsx = true;
    console.log(`✅ Wrote Excel: ${xlsxPath}`);
  } catch (e) {
    console.warn('xlsx not installed or failed, writing CSV fallback...', e.message);
  }

  if (!wroteXlsx) {
    const tPath = path.join(outDir, `${base}_trades.csv`);
    const ePath = path.join(outDir, `${base}_equity.csv`);
    const sPath = path.join(outDir, `${base}_summary.json`);
    const keys = Object.keys(trades[0] || { note: 'no-trades' });
    const lines = [keys.join(',')].concat(trades.map(t => keys.map(k => JSON.stringify(t[k] ?? '')).join(',')));
    fs.writeFileSync(tPath, lines.join('\n'));
    const elines = ['index,equity'].concat(equityCurve.map((e,i)=>`${i+1},${e}`));
    fs.writeFileSync(ePath, elines.join('\n'));
    fs.writeFileSync(sPath, JSON.stringify(summary, null, 2));
    console.log(`✅ Wrote CSV/JSON: ${tPath}\n                 ${ePath}\n                 ${sPath}`);
  }

  console.log('Summary:', summary);
}

main().catch(e => { console.error(e); process.exit(1); });
