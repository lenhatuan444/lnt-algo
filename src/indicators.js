function ema(values, period) {
  const k = 2 / (period + 1);
  let emaVal = null;
  const out = [];
  let seed = 0, cnt = 0;
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


function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (!Array.isArray(values) || values.length === 0) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period && i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    gains += ch > 0 ? ch : 0;
    losses += ch < 0 ? (-ch) : 0;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? (-ch) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? (avgGain === 0 ? 0 : 1000) : (avgGain / avgLoss);
    const rsi = 100 - (100 / (1 + rs));
    out[i] = rsi;
  }
  return out;
}

module.exports = { ema, sma, macd, atr, dailyVWAP, rsi };
