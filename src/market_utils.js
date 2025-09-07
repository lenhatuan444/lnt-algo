const { env } = require('./config');

function normalizeSymbol(exchange, symbol){
  // For Binance USD-M, prefer perpetual contract suffix
  if (exchange && exchange.id && exchange.id.includes('binance') && exchange.markets){
    if (exchange.markets[symbol]) return symbol;
    const perp = symbol.replace('/USDT', '/USDT:USDT');
    if (exchange.markets[perp]) return perp;
  }
  return symbol;
}

function normalizeSymbolList(exchange, symbols){
  return symbols.map(s => normalizeSymbol(exchange, s)).filter(Boolean);
}

module.exports = { normalizeSymbol, normalizeSymbolList };
