const https = require('node:https');

const DEFAULTS = {
  TOP_N: parseInt(process.env.MIDCAP_TOP_N || '100', 10),
  QUOTE: String(process.env.QUOTE || 'USDT').toUpperCase(),
  RANK_MIN: parseInt(process.env.RANK_MIN || '50', 10),
  RANK_MAX: parseInt(process.env.RANK_MAX || '400', 10),
  RANGE_EXPAND_STEP: parseInt(process.env.RANGE_EXPAND_STEP || '50', 10),
  RANGE_EXPAND_MAX: parseInt(process.env.RANGE_EXPAND_MAX || '1000', 10),
  USE_COINGECKO: String(process.env.USE_COINGECKO || '1') === '1',
  EXCLUDE_COINS: new Set(String(process.env.EXCLUDE_COINS || 'BTC,USDT,USDC,BUSD,FDUSD,TUSD,DAI,USDE,USDD,EURT,FRAX,USTC').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean)),
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'universe-midcap/1.0' } }, (res) => {
      let data=''; res.on('data', d=>data+=d);
      res.on('end', ()=>{ try{ resolve(JSON.parse(data||'{}')); } catch(e){ reject(e); } });
    });
    req.on('error', reject);
  });
}

async function loadSymbols(exchange, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts||{}) };
  await exchange.loadMarkets();

  const fmap = new Map();
  for (const [sym, m] of Object.entries(exchange.markets||{})) {
    if (!m?.active || !m.swap || m.linear===false) continue;
    if ((m.quote||'').toUpperCase() !== cfg.QUOTE) continue;
    const base = (m.base||'').toUpperCase();
    if (!base || cfg.EXCLUDE_COINS.has(base)) continue;
    if (!fmap.has(base)) fmap.set(base, sym);
  }

  let bases = [];
  if (cfg.USE_COINGECKO) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`;
    try {
      const arr = await fetchJson(url);
      for (const x of arr || []) {
        const rank = x?.market_cap_rank;
        const sym = String(x?.symbol||'').toUpperCase();
        if (!rank || !sym) continue;
        if (rank >= cfg.RANK_MIN && rank <= cfg.RANK_MAX && fmap.has(sym)) bases.push(sym);
      }
    } catch {}
  }
  const symbols = bases.map(b => fmap.get(b)).filter(Boolean);
  // Random sample up to TOP_N
  const A = Array.from(new Set(symbols));
  while (A.length > cfg.TOP_N) {
    const i = Math.floor(Math.random()*A.length);
    A.splice(i,1);
  }
  return A;
}

module.exports = { loadSymbols };
