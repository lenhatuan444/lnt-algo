// src/strategy.js
const { ema, macd, atr, sma, dailyVWAP } = require('./indicators');

function lastClosedIndex(arr) { return Math.max(0, arr.length - 2); }

/**
 * Compute trading signal and one-take-profit plan
 * Rules (default):
 *  - Trend filter: Daily close vs EMA(12)
 *  - Confluence: price vs daily VWAP, MACD hist cross on 4H, Volume filter
 *  - Risk: Stop = ATR(14) * atrMult (4H)
 *  - TP: ONE target only, computed as entry +/- (R * TP_RR), with optional adaptive RR by volatility.
 */
function signalFromOHLCV({ ohlcv4h, ohlcv1d }, params = {}) {
  const {
    macdFast=12, macdSlow=26, macdSignal=9,
    emaDailyLen=12,
    atrLen=14, atrMult=1.5,
    volLen=20, volRatio=1.2,
    tp1RR=1.6,                 // default RR (raised from 1.0)
    adaptTpRR=true,            // adapt RR by volatility (ATR% of price)
  } = params;

  if (!Array.isArray(ohlcv4h) || ohlcv4h.length < 200) return { reason: ['insufficient 4h data'] };
  if (!Array.isArray(ohlcv1d) || ohlcv1d.length < 50)  return { reason: ['insufficient 1d data'] };

  const idx4 = lastClosedIndex(ohlcv4h);
  const idx1 = lastClosedIndex(ohlcv1d);

  const c4 = ohlcv4h.map(r => r[4]);
  const v4 = ohlcv4h.map(r => r[5] || 0);
  const dClose = ohlcv1d.map(r => r[4]);

  // Indicators
  const vwap = dailyVWAP(ohlcv4h);
  const atr4 = atr(ohlcv4h, atrLen);
  const macdRes = macd(c4, macdFast, macdSlow, macdSignal);
  const hist = macdRes.hist;
  const emaD  = ema(dClose, emaDailyLen);
  const volMA = sma(v4, volLen);

  // Helpers
  const close4 = c4[idx4];
  const vwap4  = vwap[idx4];
  const atrNow = atr4[idx4];
  const volOk  = volMA[idx4] ? (v4[idx4] >= volMA[idx4] * volRatio) : true;
  const dailyUp = dClose[idx1] > (emaD[idx1] ?? dClose[idx1]);
  const macdUpCross = (hist[idx4 - 1] ?? 0) <= 0 && (hist[idx4] ?? 0) > 0;
  const macdDownCross = (hist[idx4 - 1] ?? 0) >= 0 && (hist[idx4] ?? 0) < 0;

  let side = null;
  if (dailyUp && close4 > vwap4 && macdUpCross && volOk) side = 'buy';
  if (!dailyUp && close4 < vwap4 && macdDownCross && volOk) side = 'sell';

  if (!side) {
    return {
      side: null,
      reason: [
        `trend:${dailyUp?'UP':'DOWN'}`,
        `vwap:${close4>vwap4?'above':'below'}`,
        `macdCross:${macdUpCross?'up':(macdDownCross?'down':'none')}`,
        `volOk:${!!volOk}`
      ]
    };
  }

  // Risk and TP
  const stopDist = Math.max(1e-8, atrNow * atrMult);
  const entry = close4;
  const stop  = side === 'buy' ? (entry - stopDist) : (entry + stopDist);

  let rr = tp1RR;
  if (adaptTpRR && entry > 0) {
    const atrPct = atrNow / entry; // volatility indicator
    if (atrPct >= 0.02) rr = Math.min(rr, 1.2);
    else if (atrPct >= 0.015) rr = Math.min(rr, 1.5);
    else rr = Math.max(rr, tp1RR); // keep base/default (e.g. 1.6-1.8)
  }

  const tp1 = side === 'buy' ? (entry + rr * stopDist) : (entry - rr * stopDist);

  return {
    side,
    entry,
    stop,
    tp1,
    tp2: null, // back-compat
    rr,
    vwap: vwap4,
    dailyEma: emaD[idx1],
    macdHistNow: hist[idx4],
    volOk,
    reason: [
      `trend:${dailyUp?'UP':'DOWN'}`,
      `VWAP:${side==='buy'?'above':'below'}`,
      `MACD:${side==='buy'?'up':'down'}-cross`,
      `VOL:${volOk?'ok':'weak'}`,
      `RR:${rr.toFixed(2)}`
    ]
  };
}

module.exports = { signalFromOHLCV, lastClosedIndex };
