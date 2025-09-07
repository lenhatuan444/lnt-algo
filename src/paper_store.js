// src/paper_store.js
const fs = require('fs');
const path = require('path');
const { env } = require('./config');

let mongo = null;
if (env.MONGO_ENABLE) {
  try { mongo = require('./db/mongo'); } catch (e) { console.error('[mongo] load err:', e.message); }
}

const PAPER_DIR = process.env.PAPER_DIR || path.join(process.cwd(), 'paper_outputs');

// Cho phép mirror CSV khi dùng Mongo nếu cần
const CSV_MIRROR_FLAG = String(process.env.PAPER_CSV_MIRROR ?? env.PAPER_CSV_MIRROR ?? '0').toLowerCase();
const CSV_MIRROR = ['1','true','yes','on'].includes(CSV_MIRROR_FLAG);

// Nếu bật Mongo thì mặc định KHÔNG ghi CSV (trừ khi CSV_MIRROR=1)
const WRITE_CSV = !env.MONGO_ENABLE || CSV_MIRROR;

function ensureDir() {
  if (!fs.existsSync(PAPER_DIR)) fs.mkdirSync(PAPER_DIR, { recursive: true });
}

function appendCSV(filename, row, headerOrder) {
  if (!WRITE_CSV) return; // skip ghi CSV khi đang dùng Mongo (và không mirror)
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
async function addEntry(open) {
  const entryTs = parseTs(open.entryTime);
  const doc = {
    ...open,
    entryTs,
    createdAt: new Date(entryTs),
  };

  appendCSV('paper_entries.csv', doc, [
    'posId','symbol','timeframe','side',
    'entryTime','entryTs','entryPlan','entryExec','qty',
    'equityBefore','slipBps','paperUseLeverage','leverage','reason'
  ]);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_ENTRIES);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addEntry err:', e.message); }
  }
}

/* ============ Partial exits (TP1/TP2/SL/BE) ============ */
async function addExit(ev) {
  const exitTs = parseTs(ev.exitTime);
  const doc = {
    ...ev,
    exitTs,
    createdAt: new Date(exitTs),
  };

  appendCSV('paper_exits.csv', doc, [
    'posId','symbol','timeframe','side',
    'label','fraction','price','qty','pnlDelta',
    'entryExec','entryTime','exitTime','exitTs','equityAfter','slipBps'
  ]);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_EXITS);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addExit err:', e.message); }
  }
}

/* ============ Closed trades (fully closed positions) ============ */
async function addTrade(trade) {
  const entryTs = parseTs(trade.entryTime);
  const exitTs  = parseTs(trade.exitTime);
  const doc = {
    ...trade,
    entryTs,
    exitTs,
    createdAt: new Date(exitTs || entryTs),
  };

  appendCSV('paper_trades.csv', doc, [
    'posId','symbol','timeframe','side',
    'entryTime','entryTs','entryPlan','entryExec',
    'exitTime','exitTs','exitAvg','qty','pnl','hits',
    'equityAfter','slipBps'
  ]);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_TRADES);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addTrade err:', e.message); }
  }

  // Ghi điểm equity tại thời điểm đóng lệnh (nếu có)
  if (trade.equityAfter != null) {
    await addEquityPoint({ time: trade.exitTime, equity: trade.equityAfter });
  }
}

/* ============ Equity curve points ============ */
async function addEquityPoint(point) {
  // Chấp nhận ISO string hoặc epoch; với CSV lưu nguyên vẹn field 'time'
  const timeTs = parseTs(point.time);
  const csvDoc = { time: point.time, equity: point.equity };
  appendCSV('paper_equity.csv', csvDoc, ['time','equity']);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_EQUITY);
      await coll.insertOne({ ...csvDoc, timeTs, createdAt: new Date(timeTs) });
    } catch (e) { console.error('[mongo] addEquityPoint err:', e.message); }
  }
}

/* ============ Position snapshots (optional) ============ */
async function addPositionSnapshot(pos) {
  const doc = { ...pos, snapshotTs: Date.now() };
  appendCSV('paper_positions.csv', doc, ['time','symbol','side','qty','entryExec','stop','tp','snapshotTs']);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_POSITIONS);
      await coll.insertOne({ ...doc, createdAt: new Date() });
    } catch (e) { console.error('[mongo] addPositionSnapshot err:', e.message); }
  }
}

module.exports = { addEntry, addExit, addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
