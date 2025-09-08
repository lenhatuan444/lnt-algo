// src/strategies/bb_rsi_mean_reversion.js
// Mean Reversion strategy using Bollinger Bands + RSI, with ATR-based stop
// Exit profile: 'mean_revert' (TP = MR_TP_RR * R, handled in bot.js)

const { atr, sma } = require('../indicators');

function lastClosedIndex(arr) { return (arr?.length || 0) - 2; }

function calcRSI(values, period = 14) {
  // Wilder's RSI (ema-like smoothing of gains/losses)
  if (!values || values.length < period + 2) return null;
  let avgGain = 0, avgLoss = 0;
  // seed
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) avgGain += ch; else avgLoss -= ch;
  }
  avgGain /= period;
  avgLoss /= period;
  const out = new Array(values.length).fill(null);
  function toRSI(g, l) {
    if (l === 0) return 100;
    const rs = g / l;
    return 100 - (100 / (1 + rs));
  }
  out[period] = toRSI(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = toRSI(avgGain, avgLoss);
  }
  return out;
}

function signalFromOHLCV({ ohlcv4h }, params = {}) {
  if (!ohlcv4h || ohlcv4h.length < 50) {
    return { side: null, reason: ['insufficient-data'] };
  }

  const closes = ohlcv4h.map(b => b[4]);
  const idx = lastClosedIndex(ohlcv4h);
  if (idx < 21) return { side: null, reason: ['insufficient-data'] };

  // Parameters (env with sensible defaults)
  const bbPeriod = Number(process.env.BB_PERIOD || params.BB_PERIOD || 20);
  const bbStd    = Number(process.env.BB_STDDEV || params.BB_STDDEV || 2.0);
  const rsiLen   = Number(process.env.RSI_LEN || params.RSI_LEN || 14);
  const rsiOB    = Number(process.env.RSI_OVERBOUGHT || params.RSI_OVERBOUGHT || 70);
  const rsiOS    = Number(process.env.RSI_OVERSOLD || params.RSI_OVERSOLD || 30);
  const atrLen   = Number(process.env.ATR_LEN || params.atrLen || 14);
  const atrMult  = Number(process.env.ATR_MULT || params.atrMult || 1.5);
  const tp1RR    = Number(process.env.MR_TP_RR || process.env.TP1_RR || params.tp1RR || 1.0);

  // --- Bollinger Bands ---
  const smaArr = sma(closes, bbPeriod);
  const mean = smaArr[idx];
  if (mean == null) return { side: null, reason: ['insufficient-data'] };

  let variance = 0;
  for (let j = idx - bbPeriod + 1; j <= idx; j++) {
    const diff = closes[j] - mean;
    variance += diff * diff;
  }
  variance /= bbPeriod;
  const stdev = Math.sqrt(Math.max(variance, 0));
  const upper = mean + bbStd * stdev;
  const lower = mean - bbStd * stdev;
  const c = closes[idx];

  // --- RSI ---
  const rsiArr = calcRSI(closes, rsiLen);
  const rsiNow = rsiArr ? rsiArr[idx] : null;
  if (rsiNow == null) return { side: null, reason: ['insufficient-data'] };

  // --- ATR for stop sizing ---
  const atrArr = atr(ohlcv4h, atrLen);
  const atrNow = atrArr ? atrArr[idx] : null;
  if (atrNow == null || atrNow <= 0) return { side: null, reason: ['atr-zero'] };

  let side = null;
  if (c < lower && rsiNow <= rsiOS) side = 'buy';
  else if (c > upper && rsiNow >= rsiOB) side = 'sell';

  if (!side) {
    return { side: null, reason: ['no-signal', `BB_up:${upper?.toFixed(6)}`, `BB_lo:${lower?.toFixed(6)}`, `RSI:${rsiNow?.toFixed(2)}`] };
  }

  const entry = c;
  const stop = side === 'buy' ? (entry - atrNow * atrMult) : (entry + atrNow * atrMult);
  const risk = Math.max(1e-9, Math.abs(entry - stop));
  const tp1  = side === 'buy' ? (entry + tp1RR * risk) : (entry - tp1RR * risk);

  const reasons = [
    side === 'buy' ? 'oversold-long' : 'overbought-short',
    `BB_up:${upper.toFixed(6)}`,
    `BB_lo:${lower.toFixed(6)}`,
    `RSI:${rsiNow.toFixed(2)}`,
    `ATR:${atrNow.toFixed(6)}`,
    'exit:mean_revert'
  ];

  return {
    side, entry, stop, tp1, tp2: null,
    exitProfile: 'mean_revert',
    atrNow,
    reason: reasons
  };
}

module.exports = { signalFromOHLCV };
