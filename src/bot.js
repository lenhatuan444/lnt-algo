const { signalFromOHLCV } = require('./strategy');
const { setLeverage, fetchEquityUSDT, calcQty, placeBracketOrders, loadState, saveState } = require('./trader');
const { env } = require('./config');

async function fetchBars(exchange, symbol, timeframe, limit=250) {
  return await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
}

async function processSymbol(exchange, symbol) {
  const [ohlcv4h, ohlcv1d] = await Promise.all([
    fetchBars(exchange, symbol, env.TIMEFRAME, 250),
    fetchBars(exchange, symbol, '1d', 120),
  ]);

  const lastClosedTs = ohlcv4h[ohlcv4h.length - 2][0];
  const state = loadState();
  const key = `${symbol}:${env.TIMEFRAME}`;
  if (state[key] && state[key] >= lastClosedTs) {
    return { symbol, skipped: true, reason: 'already-processed' };
  }

  const sig = signalFromOHLCV({ ohlcv4h, ohlcv1d }, {
    macdFast: env.MACD_FAST,
    macdSlow: env.MACD_SLOW,
    macdSignal: env.MACD_SIGNAL,
    emaDailyLen: env.DAILY_EMA,
    atrLen: env.ATR_LEN,
    atrMult: env.ATR_MULT,
    volLen: env.VOL_LEN,
    volRatio: env.VOL_RATIO,
    tp1RR: env.TP1_RR,
    tp2RR: env.TP2_RR,
  });

  if (!sig.side) {
    state[key] = lastClosedTs; saveState(state);
    return { symbol, skipped: true, reason: sig.reason?.join(',') || 'no-signal' };
  }

  const market = exchange.markets[symbol];
  const equity = await fetchEquityUSDT(exchange);

  const qty = calcQty({
    riskPct: env.RISK_PCT,
    equityUSDT: equity,
    entry: sig.entry,
    stop: sig.stop,
    market
  });

  if (!qty || qty <= 0) {
    state[key] = lastClosedTs; saveState(state);
    return { symbol, skipped: true, reason: 'qty-zero', plan: sig };
  }

  if (!env.TRADE_ENABLED) {
    state[key] = lastClosedTs; saveState(state);
    return { symbol, simulated: true, side: sig.side, qty, ...sig, reason: sig.reason };
  }

  await setLeverage(exchange, symbol, env.LEVERAGE);
  const entryOrder = await placeBracketOrders(
    exchange, symbol, sig.side, qty, sig.entry, sig.stop, sig.tp1, sig.tp2
  );

  state[key] = lastClosedTs; saveState(state);

  return {
    symbol,
    placed: true,
    side: sig.side,
    qty,
    entry: sig.entry,
    stop: sig.stop,
    tp1: sig.tp1,
    tp2: sig.tp2,
    orderId: entryOrder?.id,
    reason: sig.reason
  };
}

module.exports = { processSymbol };
