// src/strategies/atr_breakout.js
const { env } = require('../config');
const { dailyVWAP } = require('../indicators');
const { computeFeatures, chooseExitProfile, donchian } = require('../exit_profile');

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
function maxHigh(arr, a, b) { let m = -Infinity; for (let i = a; i <= b; i++) if (arr[i] > m) m = arr[i]; return m; }
function minLow (arr, a, b) { let m =  Infinity; for (let i = a; i <= b; i++) if (arr[i] < m) m = arr[i]; return m; }

function signalFromOHLCV({ ohlcv4h }, params = {}) {
  const donLen = Number(params.DONCHIAN_LEN || env.DONCHIAN_LEN || 55);
  const atrLen = Number(params.ATR_LEN || env.ATR_LEN || 14);
  const atrMult= Number(params.ATR_MULT || env.ATR_MULT || 2);
  const tp1RR  = Number(params.TP1_RR  || env.TP1_RR  || 2);
  const tp2RR  = Number(params.TP2_RR  || env.TP2_RR  || 2);

  const N = ohlcv4h?.length || 0;
  if (!N || N < Math.max(donLen + 3, atrLen + 3)) return { side: null, reason: ['insufficient-data'] };

  const last = ohlcv4h[N - 2]; // last closed bar
  const [ts, o, h, l, c, v] = last;

  // Donchian
  const highs = ohlcv4h.map(b => b[2]);
  const lows  = ohlcv4h.map(b => b[3]);
  const start = N - 2 - donLen;
  const end   = N - 3;
  const dcHigh = maxHigh(highs, start, end);
  const dcLow  = minLow(lows,  start, end);
  const rangeH = Math.max(1e-9, dcHigh - dcLow);

  // ATR & VWAP
  const atrNow = calcATR(ohlcv4h, atrLen);
  const vwapArr = dailyVWAP(ohlcv4h);
  const vwapNow = vwapArr[N - 2];

  const reasons = [`dcH:${dcHigh.toFixed(6)}`, `dcL:${dcLow.toFixed(6)}`, `ATR:${atrNow?.toFixed(6)}`];

  // Breakout logic
  if (c > dcHigh && h >= dcHigh) {
    const entry = c;
    const stop  = entry - atrMult * atrNow;
    const risk  = Math.max(1e-9, entry - stop);

    // Choose exit profile
    const feat = computeFeatures({ ohlcv4h, vwapArr }, N - 2, 'buy');
    const EXIT_MODE = (process.env.EXIT_MODE || 'auto').toLowerCase();
    const exitProfile = chooseExitProfile(feat, 'buy', EXIT_MODE, 'atr_breakout');

    // Primary TP for breakout_mm = measured move or ATR multiple
    const atrTpMult = Number(process.env.ATR_TP_MULT || 2.0);
    const tpMM = entry + rangeH;
    const tpATR= entry + atrTpMult * atrNow;
    const tp1  = exitProfile === 'breakout_mm' ? Math.max(tpMM, tpATR) : (entry + tp1RR * risk);

    reasons.push('long-breakout', `exit:${exitProfile}`);
    return { side: 'buy', entry, stop, tp1, tp2: null, reason: reasons, exitProfile, rangeH, atrNow, vwapAtEntry: vwapNow };
  }

  if (c < dcLow && l <= dcLow) {
    const entry = c;
    const stop  = entry + atrMult * atrNow;
    const risk  = Math.max(1e-9, stop - entry);

    const feat = computeFeatures({ ohlcv4h, vwapArr }, N - 2, 'sell');
    const EXIT_MODE = (process.env.EXIT_MODE || 'auto').toLowerCase();
    const exitProfile = chooseExitProfile(feat, 'sell', EXIT_MODE, 'atr_breakout');

    const atrTpMult = Number(process.env.ATR_TP_MULT || 2.0);
    const tpMM = entry - rangeH;
    const tpATR= entry - atrTpMult * atrNow;
    const tp1  = exitProfile === 'breakout_mm' ? Math.min(tpMM, tpATR) : (entry - tp1RR * risk);

    reasons.push('short-breakout', `exit:${exitProfile}`);
    return { side: 'sell', entry, stop, tp1, tp2: null, reason: reasons, exitProfile, rangeH, atrNow, vwapAtEntry: vwapNow };
  }

  return { side: null, reason: ['no-breakout', `dcH:${dcHigh.toFixed(6)}`, `dcL:${dcLow.toFixed(6)}`] };
}

module.exports = { signalFromOHLCV };
