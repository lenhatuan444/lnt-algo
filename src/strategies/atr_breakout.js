// src/strategies/atr_breakout.js
const { env } = require('../config');

function calcATR(ohlcv, len = 14) {
  if (!ohlcv || ohlcv.length < len + 2) return null;
  const trs = [];
  for (let i = 1; i < ohlcv.length; i++) {
    const [, , h, l, , ] = ohlcv[i];
    const [, , , , pc ] = ohlcv[i - 1];
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  let sum = 0;
  for (let i = trs.length - len; i < trs.length; i++) sum += trs[i];
  return sum / len;
}
function maxHigh(arr, fromIdx, toIdx) { let m = -Infinity; for (let i = fromIdx; i <= toIdx; i++) m = Math.max(m, arr[i]); return m; }
function minLow(arr, fromIdx, toIdx)  { let m =  Infinity; for (let i = fromIdx; i <= toIdx; i++) m = Math.min(m, arr[i]); return m; }

function signalFromOHLCV({ ohlcv4h }, params = {}) {
  const donLen  = Number(params.donchianLen ?? env.DONCHIAN_LEN ?? 55);
  const atrLen  = Number(params.atrLen ?? env.ATR_LEN ?? 14);
  const atrMult = Number(params.atrMult ?? env.ATR_MULT ?? 2);
  const tp1RR   = Number(params.tp1RR ?? env.TP1_RR ?? 1);
  const tp2RR   = Number(params.tp2RR ?? env.TP2_RR ?? 2);

  const N = ohlcv4h?.length || 0;
  if (N < Math.max(donLen + 3, atrLen + 3)) return { side: null, reason: ['insufficient-data'] };

  const last = ohlcv4h[N - 2];
  const [, , h, l, c] = last;

  const highs = ohlcv4h.map(b => b[2]);
  const lows  = ohlcv4h.map(b => b[3]);

  const start = N - 2 - donLen;
  const end   = N - 3;
  const dcHigh = maxHigh(highs, start, end);
  const dcLow  = minLow(lows,  start, end);

  const atr = calcATR(ohlcv4h, atrLen);
  if (!atr || !Number.isFinite(atr) || atr <= 0) return { side: null, reason: ['atr-na'] };

  const reasons = ['donchian', `len:${donLen}`, `atr:${atr.toFixed(6)}`];

  if (c > dcHigh && h >= dcHigh) {
    const entry = c;
    const stop  = entry - atrMult * atr;
    const risk  = Math.max(1e-9, entry - stop);
    const tp1   = entry + tp1RR * risk;
    const tp2   = entry + tp2RR * risk;
    reasons.push('long-breakout');
    return { side: 'buy', entry, stop, tp1, tp2, reason: reasons };
  }

  if (c < dcLow && l <= dcLow) {
    const entry = c;
    const stop  = entry + atrMult * atr;
    const risk  = Math.max(1e-9, stop - entry);
    const tp1   = entry - tp1RR * risk;
    const tp2   = entry - tp2RR * risk;
    reasons.push('short-breakout');
    return { side: 'sell', entry, stop, tp1, tp2, reason: reasons };
  }

  return { side: null, reason: ['no-breakout', `dcH:${dcHigh.toFixed(6)}`, `dcL:${dcLow.toFixed(6)}`] };
}

module.exports = { signalFromOHLCV };
