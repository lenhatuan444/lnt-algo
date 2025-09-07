// src/bot.js
let signalFromOHLCV;
try {
  const sid = String(process.env.STRATEGY || '').trim().toLowerCase();
  if (sid && sid !== 'default') {
    signalFromOHLCV = require(`./strategies/${sid}`).signalFromOHLCV;
    console.log(`[strategy] Using strategy="${sid}"`);
  } else {
    signalFromOHLCV = require('./strategy').signalFromOHLCV;
    console.log('[strategy] Using strategy="default" (./strategy.js)');
  }
} catch (e) {
  console.warn('[strategy] Fallback to ./strategy.js due to:', e.message);
  signalFromOHLCV = require('./strategy').signalFromOHLCV;
}

const {
  setLeverage, fetchEquityUSDT, calcQty, placeBracketOrders
} = require('./trader');
const { loadState, saveState } = require('./state_store');
const { env } = require('./config');
const paperStore = require('./paper_store');

async function fetchBars(exchange, symbol, timeframe, limit = 250) {
  return await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
}
function initPaper(state) {
  state.paper = state.paper || {
    equity: Number.isFinite(env.EQUITY) ? Number(env.EQUITY) : 10000,
    positions: [],
    history: []
  };
  return state.paper;
}
function nowISO(ts) { return new Date(ts ?? Date.now()).toISOString().replace('T', ' ').replace('Z', ''); }
function applySlip(price, side, slipBps, { forEntry = false } = {}) {
  const slip = Math.max(0, Number(slipBps) || 0) / 10000;
  if (forEntry) return side === 'buy' ? price * (1 + slip) : price * (1 - slip);
  return side === 'buy' ? price * (1 - slip) : price * (1 + slip);
}
function genPosId(symbol) {
  return `P-${symbol.replace(/[^A-Z0-9]/gi,'')}-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
}

/** ======== BAR-CLOSE exits (uses high/low) ======== */
function processPaperExits({ paper, symbol, bar, slipBps }) {
  const [ts, _o, high, low] = bar;
  const events = [];
  const remainPositions = [];
  let closedSomething = false;

  for (const p of paper.positions) {
    if (p.symbol !== symbol) { remainPositions.push(p); continue; }

    let remainingQty = p.qty;
    let realized = 0;
    const sideSign = p.side === 'buy' ? 1 : -1;
    const hits = [];
    const localExits = [];

    const exitFrac = (fraction, pxPlan, label, pxEffSide) => {
      const fillQty = remainingQty * fraction;
      const pxEff = applySlip(pxPlan, pxEffSide, slipBps, {});
      const pnlDelta = sideSign * (pxEff - p.entryExec) * fillQty;
      realized += pnlDelta;
      remainingQty -= fillQty;
      hits.push(label);
      localExits.push({ fraction, price: pxEff, label });

      paperStore.addExit({
        posId: p.posId,
        symbol: p.symbol,
        timeframe: env.TIMEFRAME || '4h',
        side: p.side,
        label,
        fraction,
        price: +pxEff.toFixed(6),
        qty: +fillQty.toFixed(8),
        pnlDelta: +pnlDelta.toFixed(6),
        entryExec: +p.entryExec.toFixed(6),
        entryTime: p.openedAt,
        exitTime: nowISO(ts),
        equityAfter: '',
        slipBps: Number(env.SLIPPAGE_BPS || 0)
      });

      events.push({ symbol: p.symbol, side: p.side, label, fraction, price: pxEff, when: nowISO(ts) });
    };

    if (p.side === 'buy') {
      if (low <= p.stop && remainingQty > 0) exitFrac(1.0, p.stop, 'SL', 'buy');
      if (remainingQty > 0 && !p.tp1Hit && high >= p.tp1) {
        exitFrac(0.5, p.tp1, 'TP1', 'buy');
        p.tp1Hit = true; p.stop = p.entry;
      }
      if (remainingQty > 0 && p.tp1Hit) {
        if (low <= p.entry) exitFrac(1.0, p.entry, 'BE', 'buy');
        else if (high >= p.tp2) exitFrac(1.0, p.tp2, 'TP2', 'buy');
      }
    } else {
      if (high >= p.stop && remainingQty > 0) exitFrac(1.0, p.stop, 'SL', 'sell');
      if (remainingQty > 0 && !p.tp1Hit && low <= p.tp1) {
        exitFrac(0.5, p.tp1, 'TP1', 'sell');
        p.tp1Hit = true; p.stop = p.entry;
      }
      if (remainingQty > 0 && p.tp1Hit) {
        if (high >= p.entry) exitFrac(1.0, p.entry, 'BE', 'sell');
        else if (low <= p.tp2) exitFrac(1.0, p.tp2, 'TP2', 'sell');
      }
    }

    if (remainingQty > 0) {
      p.qty = remainingQty;
      remainPositions.push(p);
    } else {
      paper.equity += realized;
      const closedFrac = localExits.reduce((s, e) => s + e.fraction, 0);
      const exitAvg = closedFrac > 0
        ? localExits.reduce((s, e) => s + e.price * e.fraction, 0) / closedFrac
        : p.entryExec;

      paper.history.push({
        posId: p.posId,
        symbol: p.symbol, side: p.side,
        entryTime: p.openedAt, entryPrice: p.entry, entryExec: p.entryExec,
        exitTime: nowISO(ts), exitAvg: +exitAvg.toFixed(6),
        qtyFilled: p.qtyOrig, pnl: +realized.toFixed(6), hits: localExits.map(e=>e.label).join('|')
      });

      paperStore.addTrade({
        posId: p.posId,
        symbol: p.symbol,
        timeframe: env.TIMEFRAME || '4h',
        side: p.side,
        entryTime: p.openedAt,
        entryPlan: p.entry,
        entryExec: +p.entryExec.toFixed(6),
        exitTime: nowISO(ts),
        exitAvg: +exitAvg.toFixed(6),
        qty: p.qtyOrig,
        pnl: +realized.toFixed(6),
        hits: localExits.map(e=>e.label).join('|'),
        equityAfter: +paper.equity.toFixed(6),
        slipBps: Number(env.SLIPPAGE_BPS || 0)
      });
    }
  }

  paper.positions = remainPositions;
  return events;
}

/** ======== REALTIME-TICK exits (uses price) ======== */
function processPaperTickInternal({ paper, symbol, price, ts, slipBps }) {
  const events = [];
  const remainPositions = [];

  for (const p of paper.positions) {
    if (p.symbol !== symbol) { remainPositions.push(p); continue; }

    let remainingQty = p.qty;
    let realized = 0;
    const sideSign = p.side === 'buy' ? 1 : -1;
    const localExits = [];

    const doExit = (fraction, pxPlan, label, pxEffSide) => {
      const fillQty = remainingQty * fraction;
      const pxEff = applySlip(pxPlan, pxEffSide, slipBps, {});
      const pnlDelta = sideSign * (pxEff - p.entryExec) * fillQty;
      realized += pnlDelta;
      remainingQty -= fillQty;
      localExits.push({ fraction, price: pxEff, label });

      paperStore.addExit({
        posId: p.posId,
        symbol: p.symbol,
        timeframe: env.TIMEFRAME || '4h',
        side: p.side,
        label,
        fraction,
        price: +pxEff.toFixed(6),
        qty: +fillQty.toFixed(8),
        pnlDelta: +pnlDelta.toFixed(6),
        entryExec: +p.entryExec.toFixed(6),
        entryTime: p.openedAt,
        exitTime: nowISO(ts),
        equityAfter: '',
        slipBps: Number(env.SLIPPAGE_BPS || 0)
      });

      events.push({ symbol: p.symbol, side: p.side, label, fraction, price: pxEff, when: nowISO(ts) });
    };

    if (p.side === 'buy') {
      if (remainingQty > 0 && price <= p.stop) doExit(1.0, p.stop, 'SL', 'buy');
      if (remainingQty > 0 && !p.tp1Hit && price >= p.tp1) {
        doExit(0.5, p.tp1, 'TP1', 'buy');
        p.tp1Hit = true; p.stop = p.entry;
      }
      if (remainingQty > 0 && p.tp1Hit) {
        if (price <= p.entry) doExit(1.0, p.entry, 'BE', 'buy');
        else if (price >= p.tp2) doExit(1.0, p.tp2, 'TP2', 'buy');
      }
    } else {
      if (remainingQty > 0 && price >= p.stop) doExit(1.0, p.stop, 'SL', 'sell');
      if (remainingQty > 0 && !p.tp1Hit && price <= p.tp1) {
        doExit(0.5, p.tp1, 'TP1', 'sell');
        p.tp1Hit = true; p.stop = p.entry;
      }
      if (remainingQty > 0 && p.tp1Hit) {
        if (price >= p.entry) doExit(1.0, p.entry, 'BE', 'sell');
        else if (price <= p.tp2) doExit(1.0, p.tp2, 'TP2', 'sell');
      }
    }

    if (remainingQty > 0) {
      p.qty = remainingQty;
      remainPositions.push(p);
    } else {
      // fully closed
      paper.equity += realized;

      const closedFrac = localExits.reduce((s, e) => s + e.fraction, 0);
      const exitAvg = closedFrac > 0
        ? localExits.reduce((s, e) => s + e.price * e.fraction, 0) / closedFrac
        : p.entryExec;

      paper.history.push({
        posId: p.posId,
        symbol: p.symbol, side: p.side,
        entryTime: p.openedAt, entryPrice: p.entry, entryExec: p.entryExec,
        exitTime: nowISO(ts), exitAvg: +exitAvg.toFixed(6),
        qtyFilled: p.qtyOrig, pnl: +realized.toFixed(6), hits: localExits.map(e=>e.label).join('|')
      });

      paperStore.addTrade({
        posId: p.posId,
        symbol: p.symbol,
        timeframe: env.TIMEFRAME || '4h',
        side: p.side,
        entryTime: p.openedAt,
        entryPlan: p.entry,
        entryExec: +p.entryExec.toFixed(6),
        exitTime: nowISO(ts),
        exitAvg: +exitAvg.toFixed(6),
        qty: p.qtyOrig,
        pnl: +realized.toFixed(6),
        hits: localExits.map(e=>e.label).join('|'),
        equityAfter: +paper.equity.toFixed(6),
        slipBps: Number(env.SLIPPAGE_BPS || 0)
      });
    }
  }

  paper.positions = remainPositions;
  if (events.length) {
    // equity point only when fully closed is handled inside trade add
  }
  return events;
}

/** ======== Entry (Paper) ======== */
function maybeOpenPaper({ paper, symbol, sig, market, riskPct, slipBps }) {
  const alreadyOpen = paper.positions.some(p => p.symbol === symbol);
  if (!sig.side || alreadyOpen) return null;

  const qty = calcQty({
    riskPct,
    equityUSDT: paper.equity,
    entry: sig.entry, stop: sig.stop, market
  });
  if (!qty || qty <= 0) return { skipped: true, reason: 'qty-zero', plan: sig };

  const entryExec = applySlip(sig.entry, sig.side, slipBps, { forEntry: true });
  const posId = genPosId(symbol);
  const pos = {
    posId,
    symbol,
    side: sig.side,
    qty: qty,
    qtyOrig: qty,
    entry: sig.entry,
    entryExec,
    stop: sig.stop,
    tp1: sig.tp1,
    tp2: sig.tp2,
    tp1Hit: false,
    openedAt: nowISO()
  };
  paper.positions.push(pos);

  try {
    paperStore.addEntry({
      posId,
      symbol,
      timeframe: env.TIMEFRAME || '4h',
      side: sig.side,
      entryTime: pos.openedAt,
      entryPlan: sig.entry,
      entryExec: +entryExec.toFixed(6),
      qty,
      equityBefore: +paper.equity.toFixed(6),
      slipBps: Number(env.SLIPPAGE_BPS || 0),
      reason: Array.isArray(sig.reason) ? sig.reason.join('|') : (sig.reason || '')
    });
  } catch (e) {
    console.error('paperStore.addEntry error:', e.message);
  }

  return { opened: true, ...pos, reason: sig.reason };
}

/** ======== Main per-symbol (scheduler) ======== */
async function processSymbol(exchange, symbol) {
  const [ohlcv4h, ohlcv1d] = await Promise.all([
    fetchBars(exchange, symbol, env.TIMEFRAME, 250),
    fetchBars(exchange, symbol, '1d', 120),
  ]);

  const lastClosedTs = ohlcv4h[ohlcv4h.length - 2][0];
  const lastClosedBar = ohlcv4h[ohlcv4h.length - 2];

  const state = await loadState();
  const key = `${symbol}:${env.TIMEFRAME}`;
  if (state[key] && state[key] >= lastClosedTs) {
    return { symbol, skipped: true, reason: 'already-processed' };
  }
  state[key] = lastClosedTs;

  const paper = initPaper(state);
  const sig = signalFromOHLCV({ ohlcv4h, ohlcv1d }, {
    macdFast: env.MACD_FAST, macdSlow: env.MACD_SLOW, macdSignal: env.MACD_SIGNAL,
    emaDailyLen: env.DAILY_EMA, atrLen: env.ATR_LEN, atrMult: env.ATR_MULT,
    volLen: env.VOL_LEN, volRatio: env.VOL_RATIO, tp1RR: env.TP1_RR, tp2RR: env.TP2_RR,
    donchianLen: env.DONCHIAN_LEN
  });

  const market = exchange.markets[symbol];

  // Always evaluate bar-close exits for currently open positions
  const exits = processPaperExits({ paper, symbol, bar: lastClosedBar, slipBps: env.SLIPPAGE_BPS });

  if (env.TRADE_ENABLED) {
    // Live: place bracket
    if (!sig.side) { await saveState(state); return { symbol, skipped: true, reason: sig.reason?.join(',') || 'no-signal' }; }
    const equity = await fetchEquityUSDT(exchange);
    const qty = calcQty({ riskPct: env.RISK_PCT, equityUSDT: equity, entry: sig.entry, stop: sig.stop, market });
    if (!qty || qty <= 0) { await saveState(state); return { symbol, skipped: true, reason: 'qty-zero', plan: sig }; }

    await setLeverage(exchange, symbol, env.LEVERAGE);
    const entryOrder = await placeBracketOrders(exchange, symbol, sig.side, qty, sig.entry, sig.stop, sig.tp1, sig.tp2);

    await saveState(state);
    return {
      symbol, placed: true, side: sig.side, qty,
      entry: sig.entry, stop: sig.stop, tp1: sig.tp1, tp2: sig.tp2,
      orderId: entryOrder?.id, reason: sig.reason
    };
  } else {
    let openRes = null;
    if (sig.side) {
      openRes = maybeOpenPaper({
        paper, symbol, sig, market, riskPct: env.RISK_PCT, slipBps: env.SLIPPAGE_BPS
      });
    }

    await saveState(state);

    if (openRes?.opened) {
      return { symbol, simulated: true, paperEntry: true, equity: +paper.equity.toFixed(6), ...openRes };
    }
    if (exits.length) {
      return { symbol, simulated: true, paperExits: exits, equity: +paper.equity.toFixed(6) };
    }
    return {
      symbol, simulated: true,
      reason: sig.side ? (openRes?.reason || 'paper-open-skipped') : (sig.reason?.join(',') || 'no-signal'),
      equity: +paper.equity.toFixed(6)
    };
  }
}

/** ======== Realtime hook ======== */
async function processRealtimeTick(symbol, price, ts = Date.now()) {
  const state = await loadState();
  const paper = initPaper(state);
  const events = processPaperTickInternal({ paper, symbol, price, ts, slipBps: env.SLIPPAGE_BPS });
  await saveState(state);
  return { symbol, paperExits: events, equity: +paper.equity.toFixed(6) };
}

module.exports = { processSymbol, processRealtimeTick };
