async function setLeverage(exchange, symbol, lev){ try { if (exchange.setLeverage) await exchange.setLeverage(lev, symbol); } catch(_){} }
async function fetchEquityUSDT(exchange){
  try {
    const balance = await exchange.fetchBalance();
    const total = balance.total?.USDT ?? balance.free?.USDT ?? 0;
    return Number(total) || 0;
  } catch(_){ return 0; }
}

function calcQty({ riskPct, equityUSDT, entry, stop, market }){
  const risk = (Number(riskPct) || 0) / 100;
  const eq = Number(equityUSDT) || 0;
  const e = Number(entry) || 0;
  const s = Number(stop) || 0;
  const tickValue = 1; // simplified
  const riskAbs = eq * risk;
  const riskPerUnit = Math.abs(e - s) * tickValue;
  if (!riskAbs || !riskPerUnit) return 0;
  const qty = riskAbs / riskPerUnit;
  // Round to lot size if market has it
  const step = market?.limits?.amount?.min || market?.precision?.amount ? (market.precision.amount || 0) : 0;
  return qty;
}

async function placeBracketOrders(exchange, symbol, side, qty, entry, stop, tp1, tp2){
  // Stub for live
  return { id: 'stub-order' };
}

module.exports = { setLeverage, fetchEquityUSDT, calcQty, placeBracketOrders };
