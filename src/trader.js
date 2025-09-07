// src/trader.js
const fs = require('fs');
const path = require('path');

function roundToStep(qty, step) {
  if (!step || step <= 0) return qty;
  const n = Math.floor(qty / step);
  return Number((n * step).toFixed(12));
}

async function setLeverage(exchange, symbol, leverage=5) {
  if (exchange.id && exchange.id.includes('binance')) {
    try { await exchange.setLeverage(leverage, symbol); } catch(_) {}
  }
}

async function fetchEquityUSDT(exchange) {
  try {
    const bal = await exchange.fetchBalance();
    const total = bal.total?.USDT ?? bal.free?.USDT ?? 0;
    return Number(total) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Risk-based position sizing
 * qty = (equityUSDT * riskPct) / |entry - stop|, rounded to market step
 */
function calcQty({ equityUSDT, riskPct, entry, stop, market }) {
  const riskUSD = Math.max(0, equityUSDT * Math.max(0, riskPct));
  const pxRisk = Math.max(1e-9, Math.abs(entry - stop));
  let qty = riskUSD / pxRisk;
  const step = market?.limits?.amount?.min || market?.precision?.amount ? (1 / Math.pow(10, market.precision.amount)) : 0;
  qty = roundToStep(qty, step);
  return Math.max(0, qty);
}

/**
 * Place 1 TP (100%) + 1 SL (100%), both reduce-only, trigger by MARK price.
 * Assumes position already opened with a market order.
 */
async function placeBracketOrders(exchange, symbol, side, qty, entry, stop, tp1) {
  const sideOpp = side === 'buy' ? 'sell' : 'buy';
  const params = { reduceOnly: true, workingType: 'MARK_PRICE' };

  // SL
  try {
    await exchange.createOrder(symbol, 'STOP_MARKET', sideOpp, qty, undefined, {
      ...params, stopPrice: stop, triggerPrice: stop
    });
  } catch(_) {}

  // Single TP for 100%
  try {
    await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', sideOpp, qty, undefined, {
      ...params, stopPrice: tp1, triggerPrice: tp1
    });
  } catch(_) {}

  return { stop, tp1 };
}

const STATE_FILE = path.join(process.cwd(), 'bot_state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(_) { return {}; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch(_) {}
}

module.exports = {
  setLeverage, fetchEquityUSDT, calcQty, placeBracketOrders, loadState, saveState
};
