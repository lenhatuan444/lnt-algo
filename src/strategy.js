const { ema, macd, atr, sma, dailyVWAP } = require('./indicators');

function lastClosedIndex(arr) { return arr.length - 2; }

function signalFromOHLCV({ ohlcv4h, ohlcv1d }, params) {
  const {
    macdFast=12, macdSlow=26, macdSignal=9,
    emaDailyLen=12,
    atrLen=14, atrMult=1.5,
    volLen=20, volRatio=1.2,
    tp1RR=1.5, tp2RR=3.0
  } = params;

  const closes4h = ohlcv4h.map(r => r[4]);
  const vol4h = ohlcv4h.map(r => r[5]);
  const vwap4h = dailyVWAP(ohlcv4h);
  const atr4h = atr(ohlcv4h, atrLen);
  const volSMA = sma(vol4h, volLen);

  const closes1d = ohlcv1d.map(r => r[4]);
  const emaDaily = ema(closes1d, emaDailyLen);

  const idx = lastClosedIndex(ohlcv4h);
  const idx1d = lastClosedIndex(ohlcv1d);
  if (idx < 1 || idx1d < 1) return { side: null, reason: ['not-enough-bars'] };

  const { hist } = macd(closes4h, macdFast, macdSlow, macdSignal);

  const c = closes4h[idx];
  const v = vol4h[idx];
  const vwap = vwap4h[idx];
  const atrNow = atr4h[idx];
  const volOk = volSMA[idx] != null ? (v >= volSMA[idx] * volRatio) : true;

  const dailyFilterUp   = closes1d[idx1d] > emaDaily[idx1d];
  const dailyFilterDown = closes1d[idx1d] < emaDaily[idx1d];

  const macdUp   = hist[idx-1] != null && hist[idx] != null && hist[idx-1] <= 0 && hist[idx] > 0;
  const macdDown = hist[idx-1] != null && hist[idx] != null && hist[idx-1] >= 0 && hist[idx] < 0;

  const aboveVWAP = vwap != null ? c > vwap : true;
  const belowVWAP = vwap != null ? c < vwap : true;

  const longOK  = dailyFilterUp && aboveVWAP && macdUp && volOk;
  const shortOK = dailyFilterDown && belowVWAP && macdDown && volOk;

  if (!longOK && !shortOK) return { side: null, reason: ['no-confluence'] };
  if (!atrNow || atrNow <= 0) return { side: null, reason: ['atr-zero'] };

  const side = longOK ? 'buy' : 'sell';
  const stop = side === 'buy' ? (c - atrNow * atrMult) : (c + atrNow * atrMult);
  const risk  = Math.abs(c - stop);
  const tp1   = side === 'buy' ? (c + risk * tp1RR) : (c - risk * tp1RR);
  const tp2   = side === 'buy' ? (c + risk * tp2RR) : (c - risk * tp2RR);

  return {
    side,
    entry: c,
    stop,
    tp1,
    tp2,
    vwap,
    dailyEma: emaDaily[idx1d],
    macdHistNow: hist[idx],
    volOk,
    reason: [
      `dailyFilter:${longOK?'UP':'DOWN'}`,
      `VWAP:${side==='buy'?'above':'below'}`,
      `MACD:${side==='buy'?'up':'down'}-cross`,
      `VOL:${volOk?'ok':'weak'}`
    ]
  };
}

module.exports = { signalFromOHLCV, lastClosedIndex };
