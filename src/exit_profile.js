// src/exit_profile.js
const { sma } = require('./indicators');

function donchian(ohlcv, len = 20) {
  const out = ohlcv.map(() => ({ hi: null, lo: null }));
  for (let i = len - 1; i < ohlcv.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - len + 1; j <= i; j++) {
      const h = ohlcv[j][2], l = ohlcv[j][3];
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    out[i] = { hi, lo };
  }
  return out;
}

function computeFeatures({ ohlcv4h, vwapArr, atrArr, macdHist }, idx, side) {
  const close = ohlcv4h[idx][4];
  const vol = ohlcv4h[idx][5] || 0;
  const atr = atrArr ? atrArr[idx] : null;
  const vwap = vwapArr ? vwapArr[idx] : null;
  const volMA = sma(ohlcv4h.map(r => r[5] || 0), 20)[idx];

  const volRatio = volMA ? (vol / volMA) : 1;
  const atrPct = (atr && close) ? (atr / close) : 0;
  const vwapDistPct = vwap ? ((close - vwap) / vwap) : 0;
  const macdMag = 0; // not used in atr_breakout

  const dc = donchian(ohlcv4h, 20);
  const hi = dc[idx]?.hi, lo = dc[idx]?.lo;
  let donchianPos = null;
  if (hi != null && lo != null && hi > lo) {
    donchianPos = (close - lo) / (hi - lo); // 0..1
  }

  return { atrPct, vwapDistPct, volRatio, donchianPos, close, atr, vwap, macdMag };
}

// Decide exit profile by regime; or return provided 'mode' if not 'auto'
function chooseExitProfile(feat, side, mode = 'auto', strategyId = 'atr_breakout') {
  const m = String(mode || 'auto').toLowerCase();
  if (m === 'map') {
    // default mapping for atr_breakout
    return 'breakout_mm';
  }
  if (m !== 'auto') return m;

  const { vwapDistPct, volRatio, donchianPos } = feat;

  // Breakout: at Donchian edge with strong volume
  if (donchianPos != null) {
    if ((side === 'buy'  && donchianPos >= 0.95 && volRatio >= 1.5) ||
        (side === 'sell' && donchianPos <= 0.05 && volRatio >= 1.5)) {
      return 'breakout_mm';
    }
  }

  // Fallbacks
  if (Math.abs(vwapDistPct) >= 0.010 && volRatio <= 1.2) {
    return 'mean_revert';
  }
  return 'trend_trail';
}

module.exports = { computeFeatures, chooseExitProfile, donchian };
