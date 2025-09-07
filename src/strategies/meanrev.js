function signalFromOHLCV({ ohlcv4h, ohlcv1d }, params){
  const last = ohlcv4h[ohlcv4h.length - 2];
  const [ts, o, h, l, c] = last;
  // naive mean reversion: buy near low wick, sell near high wick
  const body = Math.abs(c - o);
  const range = h - l || 1;
  const nearLow = (c - l) / range < 0.25;
  const nearHigh = (h - c) / range < 0.25;
  const dist = range * 0.5;
  if (nearLow){
    return { side:'buy', entry:c, stop:c - dist, tp1:c + dist, tp2:c + 2*dist, reason:['meanrev-long'] };
  }
  if (nearHigh){
    return { side:'sell', entry:c, stop:c + dist, tp1:c - dist, tp2:c - 2*dist, reason:['meanrev-short'] };
  }
  return { side:'', reason:['no-edge'] };
}
module.exports = { signalFromOHLCV };
