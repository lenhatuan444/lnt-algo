// Basic strategy: mock signal with TP/SL levels based on ATR-like range from last bars
function signalFromOHLCV({ ohlcv4h, ohlcv1d }, params){
  // For demo purposes: simple momentum
  const last = ohlcv4h[ohlcv4h.length - 2];
  const prev = ohlcv4h[ohlcv4h.length - 3];
  const [ts, o, h, l, c] = last;
  const [_ts2, o2, h2, l2, c2] = prev;

  const dirUp = c > o && c2 > o2;
  const dirDown = c < o && c2 < o2;
  const rr = 1.5;
  const stopDist = Math.max(1e-6, Math.abs(c - o) || 10);
  if (dirUp){
    return {
      side: 'buy',
      entry: c,
      stop: c - stopDist,
      tp1: c + rr * stopDist,
      tp2: c + rr * 2 * stopDist,
      reason: ['mom-up']
    };
  }
  if (dirDown){
    return {
      side: 'sell',
      entry: c,
      stop: c + stopDist,
      tp1: c - rr * stopDist,
      tp2: c - rr * 2 * stopDist,
      reason: ['mom-down']
    };
  }
  return { side: '', reason: ['no-confluence'] };
}

module.exports = { signalFromOHLCV };
