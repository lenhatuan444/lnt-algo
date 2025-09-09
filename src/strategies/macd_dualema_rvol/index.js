const { MACD, EMA, ATR } = require('technicalindicators');
const { toCols, padSeries, lastClosedIndex, zscore } = require('./filters');

const id = 'macd_dualema_rvol';

const defaults = {
  macdFast: parseInt(process.env.MACD_FAST || '12', 10),
  macdSlow: parseInt(process.env.MACD_SLOW || '26', 10),
  macdSig:  parseInt(process.env.MACD_SIGNAL || '9', 10),
  emaShortLen: parseInt(process.env.EMA_SHORT_LEN || '50', 10),
  emaLongLen:  parseInt(process.env.EMA_LONG_LEN  || '200', 10),
  atrLen:  parseInt(process.env.ATR_LEN  || '14', 10),
  atrMult: parseFloat(process.env.ATR_MULT || '1.5'),
  rvolL:   parseInt(process.env.RVOL_L || '20', 10),
  rvolZTh: parseFloat(process.env.RVOL_Z || '1.2'),
  minRRFrac: parseFloat(process.env.MIN_RR_FRAC || '0.001'),
  tpRr: parseFloat(process.env.TP_RR || '1.5'),
};

function merge(a, b) { return Object.assign({}, a || {}, b || {}); }

function signalFromOHLCV(ohlcv, ctx = {}, cfgIn = defaults) {
  const cfg = merge(defaults, cfgIn);
  if (!ohlcv || ohlcv.length < 250) {
    return { action: 'none', insufficientData: true, reason: 'insufficient-data' };
  }

  const { h, l, c, v } = toCols(ohlcv);
  const i = lastClosedIndex(ohlcv);

  const macdRaw = MACD.calculate({
    values: c, fastPeriod: cfg.macdFast, slowPeriod: cfg.macdSlow, signalPeriod: cfg.macdSig,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const macdLine   = padSeries(c.length, macdRaw.map(x => x.MACD));
  const macdSignal = padSeries(c.length, macdRaw.map(x => x.signal));
  const hist       = padSeries(c.length, macdRaw.map(x => x.histogram));

  const emaShort = padSeries(c.length, EMA.calculate({ period: cfg.emaShortLen, values: c }));
  const emaLong  = padSeries(c.length, EMA.calculate({ period: cfg.emaLongLen,  values: c }));
  const atrArr   = padSeries(c.length, ATR.calculate({ period: cfg.atrLen, high: h, low: l, close: c }));

  if (
    macdLine[i] == null || macdSignal[i] == null || hist[i] == null ||
    emaShort[i] == null || emaLong[i] == null || atrArr[i] == null || i < 1
  ) return { action: 'none', insufficientData: true, reason: 'insufficient-data' };

  const price = c[i];
  const atr   = atrArr[i];

  const macdUp   = macdLine[i - 1] <= macdSignal[i - 1] && macdLine[i] > macdSignal[i];
  const macdDown = macdLine[i - 1] >= macdSignal[i - 1] && macdLine[i] < macdSignal[i];

  const upTrend   = (price > emaShort[i]) && (emaShort[i] > emaLong[i]);
  const downTrend = (price < emaShort[i]) && (emaShort[i] < emaLong[i]);

  const rvolZ = zscore(v, cfg.rvolL, i);
  const volOK = rvolZ != null && rvolZ >= cfg.rvolZTh;

  const histUpOK = hist[i] > 0;
  const histDnOK = hist[i] < 0;

  let action = 'none';
  let stopPrice = null;
  const reasons = [];

  if (macdUp && upTrend && volOK && histUpOK) {
    action = 'buy';
    stopPrice = price - atr * cfg.atrMult;
    reasons.push('MACD cross up', `EMA${cfg.emaShortLen}>EMA${cfg.emaLongLen}`, `RVOL.z>=${cfg.rvolZTh}`, 'hist>0');
  } else if (macdDown && downTrend && volOK && histDnOK) {
    action = 'sell';
    stopPrice = price + atr * cfg.atrMult;
    reasons.push('MACD cross down', `EMA${cfg.emaShortLen}<EMA${cfg.emaLongLen}`, `RVOL.z>=${cfg.rvolZTh}`, 'hist<0');
  } else {
    return { action: 'none', reason: 'no-setup' };
  }

  const entryPrice = price;
  const R = Math.max(1e-9, Math.abs(entryPrice - stopPrice));

  const rrFrac = R / Math.max(1e-9, entryPrice);
  if (rrFrac < cfg.minRRFrac) {
    return { action: 'none', reason: `rr-too-small: R/entry=${(rrFrac).toFixed(6)} < ${cfg.minRRFrac}` };
  }

  const tp = action === 'buy' ? entryPrice + cfg.tpRr * R : entryPrice - cfg.tpRr * R;

  return {
    action,
    entryPrice,
    stopPrice,
    takeProfits: [tp],
    riskR: R,
  };
}

module.exports = { id, defaults, signalFromOHLCV: (ohlcv, ctx) => signalFromOHLCV(ohlcv, ctx, defaults) };
