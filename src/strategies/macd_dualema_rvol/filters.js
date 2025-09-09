function lastClosedIndex(ohlcv) {
  return Math.max(0, (ohlcv?.length || 0) - 2);
}
function toCols(ohlcv) {
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (const row of ohlcv) {
    t.push(row[0]); o.push(row[1]); h.push(row[2]); l.push(row[3]); c.push(row[4]); v.push(row[5] ?? 0);
  }
  return { t, o, h, l, c, v };
}
function padSeries(fullLen, arr) {
  const pad = fullLen - arr.length;
  return (pad > 0) ? Array(pad).fill(null).concat(arr) : arr.slice(-fullLen);
}
function zscore(values, lookback, i) {
  if (i == null || i < 0) return null;
  const start = i - lookback + 1;
  if (start < 0) return null;
  const window = values.slice(start, i + 1);
  if (window.length < lookback) return null;
  const mean = window.reduce((a, b) => a + b, 0) / lookback;
  const variance = window.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lookback;
  const stdev = Math.sqrt(variance) || 0;
  return stdev ? (values[i] - mean) / stdev : 0;
}
module.exports = { lastClosedIndex, toCols, padSeries, zscore };
