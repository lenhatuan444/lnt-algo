const fs = require('fs');
const path = require('path');
const { env, STRATEGY, sanitizeSid, fileFor } = require('./config');

let mongo = null;
if (env.MONGO_ENABLE) {
  try { mongo = require('./db/mongo'); } catch (e) { console.error('[mongo] load err:', e.message); }
}

const PAPER_DIR = process.env.PAPER_DIR || path.join(process.cwd(), 'paper_outputs');

function ensureDir() {
  if (!fs.existsSync(PAPER_DIR)) fs.mkdirSync(PAPER_DIR, { recursive: true });
}

function appendCSV(filename, row, headerOrder) {
  if (env.MONGO_ENABLE && env.MONGO_NO_CSV) return; // only mongo
  ensureDir();
  const p = path.join(PAPER_DIR, filename);
  const exists = fs.existsSync(p);
  const keys = headerOrder || Object.keys(row);
  const line = keys.map(k => JSON.stringify(row[k] ?? '')).join(',');
  if (!exists) {
    fs.writeFileSync(p, keys.join(',') + '\n' + line + '\n');
  } else {
    fs.appendFileSync(p, line + '\n');
  }
}

function parseTs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const t = Date.parse(val || '');
  return Number.isFinite(t) ? t : Date.now();
}

/* ============ Entries (open) ============ */
async function addEntry(open, sid=STRATEGY) {
  sid = sanitizeSid(sid);
  const entryTs = parseTs(open.entryTime);
  const doc = {
    strategy: sid,
    ...open,
    entryTs,
    createdAt: new Date(entryTs),
  };

  appendCSV(fileFor('entries', sid), doc, [
    'posId','symbol','timeframe','side',
    'entryTime','entryTs','entryPlan','entryExec','qty',
    'equityBefore','slipBps','reason','strategy'
  ]);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl('entries', sid);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addEntry err:', e.message); }
  }
}

/* ============ Partial exits (TP1/TP2/SL/BE) ============ */
async function addExit(ev, sid=STRATEGY) {
  sid = sanitizeSid(sid);
  const exitTs = parseTs(ev.exitTime);
  const doc = {
    strategy: sid,
    ...ev,
    exitTs,
    createdAt: new Date(exitTs),
  };

  appendCSV(fileFor('exits', sid), doc, [
    'posId','symbol','timeframe','side',
    'label','fraction','price','qty','pnlDelta',
    'entryExec','entryTime','exitTime','exitTs','equityAfter','slipBps','strategy'
  ]);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl('exits', sid);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addExit err:', e.message); }
  }
}

/* ============ Closed trades (fully closed positions) ============ */
async function addTrade(trade, sid=STRATEGY) {
  sid = sanitizeSid(sid);
  const entryTs = parseTs(trade.entryTime);
  const exitTs  = parseTs(trade.exitTime);
  const doc = {
    strategy: sid,
    ...trade,
    entryTs,
    exitTs,
    createdAt: new Date(exitTs || entryTs),
  };

  appendCSV(fileFor('trades', sid), doc, [
    'posId','symbol','timeframe','side',
    'entryTime','entryTs','entryPlan','entryExec',
    'exitTime','exitTs','exitAvg','qty','pnl','hits',
    'equityAfter','slipBps','strategy'
  ]);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl('trades', sid);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addTrade err:', e.message); }
  }

  // Also append an equity point at trade close (only when provided)
  if (trade.equityAfter != null) {
    await addEquityPoint({ time: trade.exitTime, equity: trade.equityAfter }, sid);
  }
}

/* ============ Equity curve points ============ */
async function addEquityPoint(point, sid=STRATEGY) {
  sid = sanitizeSid(sid);
  const timeTs = parseTs(point.time);
  const csvDoc = { time: point.time, equity: point.equity, strategy: sid };
  appendCSV(fileFor('equity', sid), csvDoc, ['time','equity','strategy']);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl('equity', sid);
      await coll.insertOne({ ...csvDoc, timeTs, createdAt: new Date(timeTs) });
    } catch (e) { console.error('[mongo] addEquityPoint err:', e.message); }
  }
}

/* ============ Position snapshots (optional) ============ */
async function addPositionSnapshot(pos, sid=STRATEGY) {
  sid = sanitizeSid(sid);
  const doc = { ...pos, snapshotTs: Date.now(), strategy: sid };
  appendCSV(fileFor('positions', sid), doc, ['time','symbol','side','qty','entryExec','stop','tp1','tp2','snapshotTs','strategy']);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl('positions', sid);
      await coll.insertOne({ ...doc, createdAt: new Date() });
    } catch (e) { console.error('[mongo] addPositionSnapshot err:', e.message); }
  }
}

module.exports = { addEntry, addExit, addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
