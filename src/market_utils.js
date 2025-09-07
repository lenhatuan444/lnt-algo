// src/market_utils.js
function resolveMarketSymbol(exchange, symbol) {
  // Already exists
  if (exchange.markets && exchange.markets[symbol]) return symbol;
  // Try colon-style contract naming for linear USDT-M
  if (symbol.endsWith('/USDT')) {
    const colon = symbol + ':USDT';
    if (exchange.markets && exchange.markets[colon]) return colon;
  }
  if (symbol.endsWith('/USD')) {
    const colon = symbol + ':USD';
    if (exchange.markets && exchange.markets[colon]) return colon;
  }
  // Fallback: search by base/quote
  const parts = symbol.split('/');
  if (parts.length === 2) {
    const [base, quote] = parts;
    const markets = Object.values(exchange.markets || {});
    // Prefer contracts on derivatives (swap=true)
    const byBQ = markets.filter(m =>
      m.base === base && (m.quote === quote || m.settle === quote)
    );
    if (byBQ.length) {
      // Prefer swap linear USDT-M first
      const sorted = byBQ.sort((a,b) => {
        const aScore = (a.swap?1:0) + (a.contract?1:0) + (a.settle==='USDT'?1:0);
        const bScore = (b.swap?1:0) + (b.contract?1:0) + (b.settle==='USDT'?1:0);
        return bScore - aScore;
      });
      return sorted[0].symbol;
    }
  }
  return null;
}

function normalizeSymbolList(exchange, symbols) {
  return symbols.map(s => resolveMarketSymbol(exchange, s) || s);
}

function isUsdtMContract(exchange, symbol) {
  const m = exchange.markets?.[symbol];
  return !!(m && m.contract && m.settle === 'USDT');
}

module.exports = { resolveMarketSymbol, normalizeSymbolList, isUsdtMContract };
