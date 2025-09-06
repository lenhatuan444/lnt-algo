// src/scheduler.js
const cron = require('node-cron');
const ccxt = require('ccxt');
const { env, SYMBOLS_ARR } = require('./config');

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function utcIso(ts = Date.now()) {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

async function fetchJustClosedClose(exchange, symbol, timeframe) {
  const limit = 3;
  const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  if (!ohlcv || ohlcv.length < 2) {
    throw new Error(`Not enough OHLCV data for ${symbol}`);
  }
  const closed = ohlcv[ohlcv.length - 2]; // penultimate is the just-closed candle
  const [ts, , , , close] = closed;
  return { symbol, close, closedAt: ts };
}

async function runJob() {
  const startedAt = Date.now();
  const startMsg = `=== 4h Close Check @ ${utcIso(startedAt)} ===`;

  if (env.LOG_JSON) {
    console.log(JSON.stringify({ level: 'info', msg: startMsg }));
  } else {
    console.log(`\n${startMsg}`);
  }

  const ExchangeClass = ccxt[env.EXCHANGE_ID];
  if (!ExchangeClass) {
    console.error(`Exchange "${env.EXCHANGE_ID}" not supported by ccxt.`);
    return;
  }
  const exchange = new ExchangeClass({ enableRateLimit: true });

  try {
    // Optional delay to avoid race with candle rollover
    if (env.POST_CLOSE_DELAY_SEC > 0) {
      await sleep(env.POST_CLOSE_DELAY_SEC * 1000);
    }

    await exchange.loadMarkets();

    const results = [];
    for (const symbol of SYMBOLS_ARR) {
      try {
        const r = await fetchJustClosedClose(exchange, symbol, env.TIMEFRAME);
        results.push(r);
      } catch (e) {
        console.error(`  ✗ ${symbol}: ${e.message}`);
      }
    }

    if (results.length) {
      const maxSym = Math.max(...results.map(r => r.symbol.length));
      const closedAt = results[0]?.closedAt;

      if (env.LOG_JSON) {
        for (const r of results) {
          console.log(JSON.stringify({
            level: 'info',
            symbol: r.symbol,
            timeframe: env.TIMEFRAME,
            closedAt: new Date(r.closedAt).toISOString(),
            close: r.close,
          }));
        }
      } else {
        if (closedAt) {
          console.log(`Just-closed ${env.TIMEFRAME} candle (closed at ${utcIso(closedAt)}):`);
        }
        for (const r of results) {
          console.log(`  ${r.symbol.padEnd(maxSym)}  close: ${r.close}`);
        }
      }
    }
  } catch (err) {
    console.error('Job error:', err);
  }
}

function schedule() {
  cron.schedule(env.CRON_EXPRESSION, () => {
    runJob();
  }, { timezone: env.CRON_TZ });
  if (env.RUN_ON_START) runJob();
}

module.exports = { schedule, runJob };
