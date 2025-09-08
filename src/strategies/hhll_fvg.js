// src/strategies/hhll_fvg.js
const { atr, sma, rsi } = require('../indicators');

function lastClosedIndex(arr) { return (arr?.length || 0) - 2; }
function isNum(x) { return Number.isFinite(x); }

function getSwings(ohlcv, lookback = 3, uptoIdx = null) {
  const highs = ohlcv.map(r => r[2]);
  const lows  = ohlcv.map(r => r[3]);
  const n = (uptoIdx == null ? ohlcv.length - 1 : uptoIdx) - lookback;
  const swingHighIdx = [], swingLowIdx = [];
  for (let i = lookback; i <= n; i++) {
    let sh = true, sl = true;
    for (let k = i - lookback; k <= i + lookback; k++) {
      if (k === i) continue;
      if (highs[i] <= highs[k]) sh = false;
      if (lows[i]  >= lows[k])  sl = false;
      if (!sh && !sl) break;
    }
    if (sh) swingHighIdx.push(i);
    if (sl) swingLowIdx.push(i);
  }
  return { swingHighIdx, swingLowIdx };
}

function detectStructure(ohlcv, swings, uptoIdx) {
  const highs = ohlcv.map(r => r[2]);
  const lows  = ohlcv.map(r => r[3]);
  const sh = swings.swingHighIdx.filter(i => i < uptoIdx);
  const sl = swings.swingLowIdx.filter(i => i < uptoIdx);
  if (sh.length < 2 || sl.length < 2) return { bias: 'unknown' };

  const lastSH = sh[sh.length - 1];
  const prevSH = sh[sh.length - 2];
  const lastSL = sl[sl.length - 1];
  const prevSL = sl[sl.length - 2];

  const HH = highs[lastSH] > highs[prevSH];
  const HL = lows[lastSL]  > lows[prevSL];
  const LL = lows[lastSL]  < lows[prevSL];
  const LH = highs[lastSH] < highs[prevSH];

  let bias = 'unknown';
  if (HH && HL) bias = 'bull';
  else if (LL && LH) bias = 'bear';
  else if (HH) bias = 'bull';
  else if (LL) bias = 'bear';

  return { bias, lastSH, prevSH, lastSL, prevSL, highs, lows };
}

function bps(x) { return x * 10000; }

function findRecentFVG(ohlcv, uptoIdx, { minBps = 5, lookbackBars = 120 } = {}) {
  const highs = ohlcv.map(r => r[2]);
  const lows  = ohlcv.map(r => r[3]);
  const closes= ohlcv.map(r => r[4]);
  const start = Math.max(2, uptoIdx - lookbackBars);
  let lastBull = null, lastBear = null;

  for (let i = start; i <= uptoIdx; i++) {
    const h1 = highs[i - 2], l1 = lows[i - 2];
    const h3 = highs[i],     l3 = lows[i];
    if (!isNum(h1) || !isNum(l1) || !isNum(h3) || !isNum(l3)) continue;

    if (l3 > h1) { // Bullish FVG
      const lower = h1, upper = l3;
      const width = upper - lower;
      const mid   = (lower + upper) / 2;
      const relBps= bps(width / closes[i]);
      if (relBps >= minBps) lastBull = { i, lower, upper, mid, width, type: 'bull' };
    }
    if (h3 < l1) { // Bearish FVG
      const lower = h3, upper = l1;
      const width = upper - lower;
      const mid   = (lower + upper) / 2;
      const relBps= bps(width / closes[i]);
      if (relBps >= minBps) lastBear = { i, lower, upper, mid, width, type: 'bear' };
    }
  }
  return { bull: lastBull, bear: lastBear };
}

function touched(zone, o, h, l, c) {
  return zone && (l <= zone.upper) && (h >= zone.lower);
}

function signalFromOHLCV({ ohlcv4h }, params = {}) {
  if (!ohlcv4h || ohlcv4h.length < 80) return { side: null, reason: ['insufficient-data'] };

  const idx = (ohlcv4h?.length || 0) - 2;
  if (idx < 50) return { side: null, reason: ['insufficient-data'] };

  const swingLB      = Number(process.env.SWING_LOOKBACK || params.SWING_LOOKBACK || 3);
  const minFvgBps    = Number(process.env.FVG_MIN_BPS || params.FVG_MIN_BPS || 5);
  const fvgLookback  = Number(process.env.FVG_LOOKBACK_BARS || params.FVG_LOOKBACK_BARS || 120);
  const atrLen       = Number(process.env.ATR_LEN || params.ATR_LEN || 14);
  const stopMode     = String(process.env.STOP_MODE || params.STOP_MODE || 'atr'); // 'atr' | 'pct' | 'fvg'
  const stopAtrMult  = Number(process.env.STOP_ATR_MULT || params.STOP_ATR_MULT || 1.2);
  const stopPct      = Number(process.env.STOP_PCT || params.STOP_PCT || 0.01);
  const tpRR         = Number(process.env.TP_RR || params.TP_RR || process.env.TP1_RR || params.TP1_RR || 2.0);
  const rsiLen       = Number(process.env.RSI_LEN || params.RSI_LEN || 14);
  const rsiBuyMax    = Number(process.env.RSI_BUY_MAX || params.RSI_BUY_MAX || 35);
  const rsiSellMin   = Number(process.env.RSI_SELL_MIN || params.RSI_SELL_MIN || 65);

  const swings = getSwings(ohlcv4h, swingLB, idx);
  const { bias } = detectStructure(ohlcv4h, swings, idx);
  if (bias === 'unknown') return { side: null, reason: ['no-structure'] };

  const fvg = findRecentFVG(ohlcv4h, idx, { minBps: minFvgBps, lookbackBars: fvgLookback });
  const o = ohlcv4h[idx][1], h = ohlcv4h[idx][2], l = ohlcv4h[idx][3], c = ohlcv4h[idx][4];

  const atrArr = atr(ohlcv4h, atrLen);
  const atrNow = atrArr[idx];
  if (!Number.isFinite(atrNow) || atrNow <= 0) return { side: null, reason: ['atr-zero'] };

  const closes = ohlcv4h.map(r => r[4]);
  const rsiArr = rsi(closes, rsiLen);
  const rsiNow = rsiArr[idx];
  if (!Number.isFinite(rsiNow)) return { side: null, reason: ['rsi-na'] };

  let side = null, entry = c, stop = null, tp1 = null, reasons = [];
  if (bias === 'bull' && fvg.bull && touched(fvg.bull, o, h, l, c)) {
    if (!(rsiNow <= rsiBuyMax)) return { side: null, reason: ['rsi-not-oversold', rsiNow.toFixed(2)] };
    side = 'buy';
    if (stopMode === 'fvg')      stop = fvg.bull.lower;
    else if (stopMode === 'pct') stop = entry * (1 - stopPct);
    else                         stop = Math.min(fvg.bull.lower, l) - atrNow * (stopAtrMult - 1);
    const risk = Math.max(1e-9, entry - stop);
    tp1 = entry + tpRR * risk;
    reasons.push('bias:bull','retest:bull_fvg', `RSI:${rsiNow.toFixed(2)}`);
  } else if (bias === 'bear' && fvg.bear && touched(fvg.bear, o, h, l, c)) {
    if (!(rsiNow >= rsiSellMin)) return { side: null, reason: ['rsi-not-overbought', rsiNow.toFixed(2)] };
    side = 'sell';
    if (stopMode === 'fvg')      stop = fvg.bear.upper;
    else if (stopMode === 'pct') stop = entry * (1 + stopPct);
    else                         stop = Math.max(fvg.bear.upper, h) + atrNow * (stopAtrMult - 1);
    const risk = Math.max(1e-9, stop - entry);
    tp1 = entry - tpRR * risk;
    reasons.push('bias:bear','retest:bear_fvg', `RSI:${rsiNow.toFixed(2)}`);
  }

  if (!side) {
    const z = bias === 'bull' ? fvg.bull : fvg.bear;
    return { side: null, reason: ['no-retest-or-rsi', `bias:${bias}`, z ? `lastFvg:[${z.lower.toFixed(6)}..${z.upper.toFixed(6)}]` : 'no-fvg'] };
  }

  return { side, entry:+entry.toFixed(6), stop:+stop.toFixed(6), tp1:+tp1.toFixed(6), tp2:null, exitProfile:'trend_trail', reason:reasons };
}

module.exports = { signalFromOHLCV };
