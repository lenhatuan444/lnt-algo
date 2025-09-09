function num(x){const n=Number(x);return (isFinite(n)?n:0)||0;}
function pctToFrac(x){const n=Number(x);return isFinite(n)?(n>1?n/100:n/100):0;}

function amountToPrecisionSafe(exchange, symbol, qty){
  try { return Number(exchange.amountToPrecision(symbol, qty)); }
  catch { return Math.floor(qty*1e6)/1e6; }
}

async function simulateOpenLong(exchange, symbol, sig, opts={}){
  const equity = num(opts.equity ?? process.env.EQUITY ?? 10000);
  const riskPctFrac = (opts.riskPctFrac!=null)?num(opts.riskPctFrac):pctToFrac(process.env.RISK_PCT ?? 1);
  const lev = num(opts.leverage ?? process.env.LEVERAGE ?? 20);
  const tpRr = num(opts.tpRr ?? process.env.TP_RR ?? 1.5);

  const entry = num(sig.entryPrice);
  const stop  = num(sig.stopPrice);
  const R     = num(sig.riskR ?? Math.abs(entry-stop));
  if (!(entry>0&&stop>0&&R>0)) return { ok:false, symbol, reason:'invalid-signal' };

  const market = exchange.markets?.[symbol];
  const risk$Target = equity * riskPctFrac;

  let qty = risk$Target / R;
  qty = amountToPrecisionSafe(exchange, symbol, qty);
  if (market?.limits?.amount?.min && qty < market.limits.amount.min) qty = market.limits.amount.min;

  let notional = entry*qty;
  if (market?.limits?.cost?.min && notional < market.limits.cost.min){
    const needQty = market.limits.cost.min / Math.max(1e-9, entry);
    qty = Math.max(qty, amountToPrecisionSafe(exchange, symbol, needQty));
    notional = entry*qty;
  }
  if (!(qty>0)) return { ok:false, symbol, reason:'qty-zero' };

  const margin = notional / Math.max(1e-9, lev);
  const risk$  = Math.abs(entry-stop)*qty;
  const tp = entry + tpRr*R;

  return { ok:true, side:'long', symbol, leverage:lev,
    entryPrice:entry, stopPrice:stop, takeProfit:tp, rrTarget:tpRr, riskR:R,
    qty, notional, margin, riskDollar:risk$
  };
}

module.exports = { simulateOpenLong };
