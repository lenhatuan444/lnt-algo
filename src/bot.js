// src/bot.js
// Paper trading when TRADE_ENABLED=false; real orders when true.
// - Paper mode: open simulated position, manage TP1 -> move SL to BE, TP2/SL/BE, compute PnL
// - State is stored in bot_state.json (paper.positions, paper.history, paper.equity)
const paperStore = require('./paper_store');
const { signalFromOHLCV } = require('./strategy');
const {
  setLeverage, fetchEquityUSDT, calcQty, placeBracketOrders,
  loadState, saveState
} = require('./trader');
const { env } = require('./config');

/** Fetch OHLCV helpers */
async function fetchBars(exchange, symbol, timeframe, limit = 250) {
  return await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
}

/** ============ Paper trade helpers ============ */
function initPaper(state) {
  state.paper = state.paper || {
    equity: Number.isFinite(env.EQUITY) ? env.EQUITY : 10000,
    positions: [], // open positions
    history: []    // closed positions
  };
  return state.paper;
}

function nowISO(ts) { return new Date(ts ?? Date.now()).toISOString().replace('T', ' ').replace('Z', ''); }

function applySlip(price, side, slipBps, { forEntry = false } = {}) {
  const slip = Math.max(0, Number(slipBps) || 0) / 10000; // bps -> decimal
  if (forEntry) {
    return side === 'buy' ? price * (1 + slip) : price * (1 - slip);
  } else {
    return side === 'buy' ? price * (1 - slip) : price * (1 + slip);
  }
}

/**
 * Process exits for a single just-closed 4h bar.
 * Strategy:
 *  - Long: check SL first, then TP1 (50%), then BE (after TP1), rồi TP2
 *  - Short: đối xứng
 * Ghi chú: Vì OHLC trên cùng 1 nến không biết thứ tự xảy ra thực tế, ưu tiên SL trước (bảo thủ).
 */
function processPaperExits({ paper, symbol, bar, slipBps }) {
  const [ts, _o, high, low, close] = bar;
  const events = [];
  const remainPositions = [];

  for (const p of paper.positions) {
    if (p.symbol !== symbol) { remainPositions.push(p); continue; }

    let remainingQty = p.qty;
    let realized = 0;
    const sideSign = p.side === 'buy' ? 1 : -1;
    const hits = [];
    const localExits = []; // gom exit của position này để tính avg

    const exitFrac = (fraction, price, label) => {
      const fillQty = remainingQty * fraction;
      const pnlPerUnit = sideSign * (price - p.entryExec);
      realized += pnlPerUnit * fillQty;
      remainingQty -= fillQty;
      hits.push(label);
      localExits.push({ fraction, price, label });
      events.push({ symbol: p.symbol, side: p.side, label, fraction, price, when: nowISO(ts) });
    };

    if (p.side === 'buy') {
      if (low <= p.stop && remainingQty > 0) exitFrac(1.0, applySlip(p.stop, 'buy', slipBps, {}), 'SL');
      if (remainingQty > 0 && !p.tp1Hit && high >= p.tp1) {
        exitFrac(0.5, applySlip(p.tp1, 'buy', slipBps, {}), 'TP1');
        p.tp1Hit = true; p.stop = p.entry; // dời SL về BE
      }
      if (remainingQty > 0 && p.tp1Hit) {
        if (low <= p.entry) exitFrac(1.0, applySlip(p.entry, 'buy', slipBps, {}), 'BE');
        else if (high >= p.tp2) exitFrac(1.0, applySlip(p.tp2, 'buy', slipBps, {}), 'TP2');
      }
    } else {
      if (high >= p.stop && remainingQty > 0) exitFrac(1.0, applySlip(p.stop, 'sell', slipBps, {}), 'SL');
      if (remainingQty > 0 && !p.tp1Hit && low <= p.tp1) {
        exitFrac(0.5, applySlip(p.tp1, 'sell', slipBps, {}), 'TP1');
        p.tp1Hit = true; p.stop = p.entry;
      }
      if (remainingQty > 0 && p.tp1Hit) {
        if (high >= p.entry) exitFrac(1.0, applySlip(p.entry, 'sell', slipBps, {}), 'BE');
        else if (low <= p.tp2) exitFrac(1.0, applySlip(p.tp2, 'sell', slipBps, {}), 'TP2');
      }
    }

    if (remainingQty > 0) {
      p.qty = remainingQty;
      remainPositions.push(p);
    } else {
      // Đóng hoàn toàn → cập nhật equity, lưu trade CSV
      paper.equity += realized;

      // Tính exitAvg theo tỉ lệ phần đã đóng
      const closedFrac = localExits.reduce((s, e) => s + e.fraction, 0);
      const exitAvg = closedFrac > 0
        ? localExits.reduce((s, e) => s + e.price * e.fraction, 0) / closedFrac
        : p.entryExec;

      // Lưu lịch sử trong state
      paper.history.push({
        symbol: p.symbol, side: p.side,
        entryTime: p.openedAt, entryPrice: p.entry, entryExec: p.entryExec,
        exitTime: nowISO(ts), exitAvg: +exitAvg.toFixed(6),
        qtyFilled: p.qtyOrig, pnl: +realized.toFixed(6),
        hits: hits.join('|')
      });

      // Ghi CSV trade
      paperStore.addTrade({
        symbol: p.symbol,
        timeframe: process.env.TIMEFRAME || '4h',
        side: p.side,
        entryTime: p.openedAt,
        entryPlan: p.entry,
        entryExec: +p.entryExec.toFixed(6),
        exitTime: nowISO(ts),
        exitAvg: +exitAvg.toFixed(6),
        qty: p.qtyOrig,
        pnl: +realized.toFixed(6),
        hits: hits.join('|'),
        equityAfter: +paper.equity.toFixed(6),
        slipBps: Number(process.env.SLIPPAGE_BPS || 0)
      });
    }
  }

  paper.positions = remainPositions;

  // Ghi point equity mỗi nến (dù có/không có đóng lệnh)
  paperStore.addEquityPoint({ time: nowISO(ts), equity: +paper.equity.toFixed(6) });

  return events;
}

/** Try open a paper position if there is a signal and no open position for the same symbol */
function maybeOpenPaper({ paper, symbol, sig, market, riskPct, slipBps }) {
  const alreadyOpen = paper.positions.some(p => p.symbol === symbol);
  if (!sig.side || alreadyOpen) return null;

  const qty = calcQty({
    riskPct,
    equityUSDT: paper.equity,
    entry: sig.entry,
    stop: sig.stop,
    market
  });
  if (!qty || qty <= 0) return { skipped: true, reason: 'qty-zero', plan: sig };

  const entryExec = applySlip(sig.entry, sig.side, slipBps, { forEntry: true });
  const pos = {
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

  return {
    opened: true,
    ...pos,
    reason: sig.reason
  };
}

/** ============ Main per-symbol ============ */
async function processSymbol(exchange, symbol) {
  // Load data
  const [ohlcv4h, ohlcv1d] = await Promise.all([
    fetchBars(exchange, symbol, env.TIMEFRAME, 250),
    fetchBars(exchange, symbol, '1d', 120),
  ]);

  const lastClosedTs = ohlcv4h[ohlcv4h.length - 2][0];
  const lastClosedBar = ohlcv4h[ohlcv4h.length - 2];

  // Load state & de-dupe per candle
  const state = loadState();                   // uses bot_state.json
  const key = `${symbol}:${env.TIMEFRAME}`;
  if (state[key] && state[key] >= lastClosedTs) {
    return { symbol, skipped: true, reason: 'already-processed' };
  }
  const paper = initPaper(state);

  // Build signal (for potential entry)
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

  const market = exchange.markets[symbol];

  // Always process paper exits once per closed bar
  const exits = processPaperExits({
    paper,
    symbol,
    bar: lastClosedBar,
    slipBps: env.SLIPPAGE_BPS
  });

  if (env.TRADE_ENABLED) {
    // Real trading path (unchanged)
    if (!sig.side) {
      state[key] = lastClosedTs; saveState(state);
      return { symbol, skipped: true, reason: sig.reason?.join(',') || 'no-signal' };
    }

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
  } else {
    // ===== PAPER MODE =====
    let openRes = null;
    if (sig.side) {
      openRes = maybeOpenPaper({
        paper,
        symbol,
        sig,
        market,
        riskPct: env.RISK_PCT,
        slipBps: env.SLIPPAGE_BPS
      });
    }

    // mark candle processed & persist
    state[key] = lastClosedTs;
    saveState(state);

    // Compose return for logs
    if (openRes?.opened) {
      return {
        symbol,
        simulated: true,
        paperEntry: true,
        equity: +paper.equity.toFixed(6),
        ...openRes
      };
    }
    if (exits.length) {
      return {
        symbol,
        simulated: true,
        paperExits: exits,
        equity: +paper.equity.toFixed(6)
      };
    }
    return {
      symbol,
      simulated: true,
      reason: sig.side ? (openRes?.reason || 'paper-open-skipped') : (sig.reason?.join(',') || 'no-signal'),
      equity: +paper.equity.toFixed(6)
    };
  }
}

module.exports = { processSymbol };
