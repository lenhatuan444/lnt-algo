const fs = require('fs');
const path = require('path');

function roundToStep(qty, step) {
  if (!step || step <= 0) return qty;
  const n = Math.floor(qty / step);
  return Number((n * step).toFixed(12));
}

async function setLeverage(exchange, symbol, leverage=5) {
  if (exchange.id.includes('binance')) {
    try { await exchange.setLeverage(leverage, symbol); } catch(_) {}
  }
}

async function fetchEquityUSDT(exchange) {
  try {
    const b = await exchange.fetchBalance();
    const total = (b.total?.USDT ?? b.info?.totalWalletBalance ?? 0);
    return Number(total) || 0;
  } catch (e) {
    return 0;
  }
}

function calcQty({ riskPct=0.01, equityUSDT, entry, stop, market }) {
  const risk$ = equityUSDT * riskPct;
  const riskPerUnit = Math.abs(entry - stop);
  if (riskPerUnit <= 0) return 0;
  let qty = risk$ / riskPerUnit;
  const prec = market.precision?.amount ?? 6;
  const step = market.limits?.amount?.min || (1 / (10 ** prec));
  qty = roundToStep(qty, step);
  return qty;
}

async function placeBracketOrders(exchange, symbol, side, qty, entry, stop, tp1, tp2) {
  const antiSide = side === 'buy' ? 'sell' : 'buy';
  const entryOrder = await exchange.createOrder(symbol, 'market', side, qty, undefined, { reduceOnly: false });
  await exchange.createOrder(symbol, 'STOP_MARKET', antiSide, qty, undefined, {
    stopPrice: stop, reduceOnly: true, workingType: 'MARK_PRICE'
  });
  await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', antiSide, qty/2, undefined, {
    stopPrice: tp1, reduceOnly: true, workingType: 'MARK_PRICE'
  });
  await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', antiSide, qty - qty/2, undefined, {
    stopPrice: tp2, reduceOnly: true, workingType: 'MARK_PRICE'
  });
  return entryOrder;
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
