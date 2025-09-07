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

function nowISO(ts) {
  return new Date(ts ?? Date.now()).toISOString().replace('T', ' ').replace('Z', '');
}

function applySlip(price, side, slipBps, { forEntry = false } = {}) {
  const slip = Math.max(0, Number(slipBps) || 0) / 10000;
  if (forEntry) return side === 'buy' ? price * (1 + slip) : price * (1 - slip);
  return side === 'buy' ? price * (1 - slip) : price * (1 + slip);
}

function genPosId(symbol) {
  return `P-${symbol.replace(/[^A-Z0-9]/gi,'')}-${Date.now()}-${Math.floor(Math.random()*1e6)}`;
}

// === Exit engine helpers (profile-based) ===
function initExitForPos(pos) {
  pos.riskR = Math.max(1e-9, Math.abs(pos.entry - pos.stop));
  pos.exitProfile = pos.exitProfile || (pos.exit || 'trend_trail');

  // Default TP per profile
  if (pos.exitProfile === 'breakout_mm') {
    // use measured move (rangeH) or ATR multiple
    const atrTpMult = Number(process.env.ATR_TP_MULT || 2.0);
    if (pos.side === 'buy') {
      const tpMM = pos.rangeH ? (pos.entryExec + pos.rangeH) : null;
      const tpATR= pos.entryExec + atrTpMult * (pos.atrNow || pos.riskR);
      pos.tp = tpMM ? Math.max(tpMM, tpATR) : tpATR;
    } else {
      const tpMM = pos.rangeH ? (pos.entryExec - pos.rangeH) : null;
      const tpATR= pos.entryExec - atrTpMult * (pos.atrNow || pos.riskR);
      pos.tp = tpMM ? Math.min(tpMM, tpATR) : tpATR;
    }
  } else if (pos.exitProfile === 'trend_trail') {
    const rrHard = Number(process.env.HARD_TP_RR_TREND || 5.0);
    pos.tp = pos.side === 'buy' ? pos.entryExec + rrHard * pos.riskR : pos.entryExec - rrHard * pos.riskR;
    pos.highestClose = pos.entryExec;
    pos.lowestClose  = pos.entryExec;
    pos.chandelierK  = Number(process.env.CHANDELIER_K || 3.5);
  } else if (pos.exitProfile === 'mean_revert') {
    const mrRR = Number(process.env.MR_TP_RR || 1.0);
    pos.tp = pos.side === 'buy' ? pos.entryExec + mrRR * pos.riskR : pos.entryExec - mrRR * pos.riskR;
  } else if (pos.exitProfile === 'pullback_two_step') {
    const rr = Number(process.env.TP1_RR || 1.6);
    pos.tp = pos.side === 'buy' ? pos.entryExec + rr * pos.riskR : pos.entryExec - rr * pos.riskR;
  } else {
    // fallback
    const rr = Number(process.env.TP1_RR || 1.6);
    pos.tp = pos.side === 'buy' ? pos.entryExec + rr * pos.riskR : pos.entryExec - rr * pos.riskR;
  }
  pos.openBars = 0;
  return pos;
}

function updateExitForPosOnBar(pos, bar) {
  // bar: [ts,o,h,l,c,v]
  const c = bar[4];
  pos.openBars = (pos.openBars || 0) + 1;

  if (pos.exitProfile === 'trend_trail') {
    if (pos.side === 'buy') {
      pos.highestClose = Math.max(pos.highestClose || -Infinity, c);
      const newStop = (pos.highestClose - (pos.chandelierK || 3.5) * (pos.atrNow || pos.riskR));
      pos.stop = Math.max(pos.stop, newStop);
    } else {
      pos.lowestClose = Math.min(pos.lowestClose || Infinity, c);
      const newStop = (pos.lowestClose + (pos.chandelierK || 3.5) * (pos.atrNow || pos.riskR));
      pos.stop = Math.min(pos.stop, newStop);
    }
  } else if (pos.exitProfile === 'breakout_mm') {
    // time-stop: if not reach 0.5R after N bars -> exit at close
    const [ , , high, low ] = bar;
    const maxFavorableR = pos.side === 'buy'
      ? ((high - pos.entryExec) / pos.riskR)
      : ((pos.entryExec - low) / pos.riskR);
    const tsBars = Number(process.env.TIME_STOP_BARS || 6);
    if (pos.openBars >= tsBars && maxFavorableR < 0.5) {
      return { forceExit: true, label: 'TIME_STOP', price: c };
    }
  } else if (pos.exitProfile === 'mean_revert') {
    // Optionally could update TP toward mean; keeping static for now
  }
  return { };
}

/** ======== BAR-CLOSE exits (uses high/low) ======== */
function processPaperExits({ paper, symbol, bar, slipBps }) {
  const [ts, _o, high, low] = bar;
  const events = [];
  const remainPositions = [];

  for (const p of paper.positions) {
    if (p.symbol !== symbol) { remainPositions.push(p); continue; }

    let remainingQty = p.qty;

    // profile-based update on bar-close
    const upd = updateExitForPosOnBar(p, bar);
    if (upd && upd.forceExit && remainingQty > 0) {
      // quick full exit
      const sideSign = p.side === 'buy' ? 1 : -1;
      let realized = sideSign * (upd.price - p.entryExec) * remainingQty;
      const pxEff = applySlip(upd.price, p.side, slipBps, {});
      realized = sideSign * (pxEff - p.entryExec) * remainingQty;

      paperStore.addExit({
        posId: p.posId,
        symbol: p.symbol,
        timeframe: env.TIMEFRAME || '4h',
        side: p.side,
        label: upd.label,
        fraction: 1.0,
        price: +pxEff.toFixed(6),
        qty: +remainingQty.toFixed(8),
        pnlDelta: +realized.toFixed(6),
        entryExec: +p.entryExec.toFixed(6),
        entryTime: p.openedAt,
        exitTime: nowISO(ts),
        equityAfter: '',
        slipBps: Number(env.SLIPPAGE_BPS || 0)
      });
      // finalize trade
      paper.equity += realized;
      const exitAvg = pxEff;
      paper.history.push({
        posId: p.posId,
        symbol: p.symbol, side: p.side,
        entryTime: p.openedAt, entryPrice: p.entry, entryExec: p.entryExec,
        exitTime: nowISO(ts), exitAvg: +exitAvg.toFixed(6),
        qtyFilled: p.qtyOrig, pnl: +realized.toFixed(6), hits: upd.label
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
        hits: upd.label,
        equityAfter: +paper.equity.toFixed(6),
        slipBps: Number(env.SLIPPAGE_BPS || 0)
      });
      // position closed
      continue;
    }

    let realized = 0;
    const sideSign = p.side === 'buy' ? 1 : -1;
    const localExits = [];

    const exitFrac = (fraction, pxPlan, label, pxEffSide) => {
      const fillQty = remainingQty * fraction;
      const pxEff = applySlip(pxPlan, pxEffSide, slipBps, {});
      const pnlDelta = sideSign * (pxEff - p.entryExec) * fillQty;
      realized += pnlDelta;
      remainingQty -= fillQty;
      localExits.push({ fraction, price: pxEff, label });

      // log partial exit
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
      if (remainingQty > 0 && high >= p.tp) { exitFrac(1.0, p.tp, 'TP_FULL', 'buy'); }
    } else {
      if (high >= p.stop && remainingQty > 0) exitFrac(1.0, p.stop, 'SL', 'sell');
      if (remainingQty > 0 && low <= p.tp) { exitFrac(1.0, p.tp, 'TP_FULL', 'sell'); }
    }

    if (remainingQty > 0) {
      p.qty = remainingQty;
      remainPositions.push(p);
    } else {
      // fully closed -> realize PnL to equity, record trade
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
      if (remainingQty > 0 && price >= p.tp)   doExit(1.0, p.tp,   'TP_FULL', 'buy');
    } else {
      if (remainingQty > 0 && price >= p.stop) doExit(1.0, p.stop, 'SL', 'sell');
      if (remainingQty > 0 && price <= p.tp)   doExit(1.0, p.tp,   'TP_FULL', 'sell');
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
    exitProfile: sig.exitProfile,
    rangeH: sig.rangeH,
    atrNow: sig.atrNow,
    vwapEntry: sig.vwapAtEntry,
    tp: sig.tp1,
    tp1Hit: false,
    openedAt: nowISO()
  };
  paper.positions.push(initExitForPos(pos));

  try {
    // 1) Lưu log entry
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

    // 2) Lưu snapshot positions ngay khi vào lệnh (CSV + Mongo nếu bật)
    paperStore.addPositionSnapshot({
      time: pos.openedAt,
      posId,
      symbol: pos.symbol,
      side: pos.side,
      qty: pos.qty,
      entryExec: +pos.entryExec.toFixed(6),
      stop: pos.stop,
      tp: pos.tp
    });
  } catch (e) {
    console.error('paperStore entry/snapshot error:', e.message);
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
    if (!sig.side) { await saveState(state); return { symbol, skipped: true, reason: Array.isArray(sig.reason) ? sig.reason : (sig.reason ? [sig.reason] : []) }; }
    const equity = await fetchEquityUSDT(exchange);
    const qty = calcQty({ riskPct: env.RISK_PCT, equityUSDT: equity, entry: sig.entry, stop: sig.stop, market });
    if (!qty || qty <= 0) { await saveState(state); return { symbol, skipped: true, reason: ['qty-zero'], plan: sig }; }

    await setLeverage(exchange, symbol, env.LEVERAGE);
    const entryOrder = await placeBracketOrders(exchange, symbol, sig.side, qty, sig.entry, sig.stop, sig.tp1);

    await saveState(state);
    return {
      symbol, placed: true, side: sig.side, qty,
      entry: sig.entry, stop: sig.stop, tp1: sig.tp1,
      orderId: entryOrder?.id,
      reason: Array.isArray(sig.reason) ? sig.reason : (sig.reason ? [sig.reason] : [])
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
      reason: sig.side
        ? (openRes?.reason || 'paper-open-skipped')
        : (Array.isArray(sig.reason) ? sig.reason.join(',') : (sig.reason || 'no-signal')),
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
