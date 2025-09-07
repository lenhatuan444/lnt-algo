// src/paper_store.js
const fs = require('fs');
const path = require('path');
const { env } = require('./config');

let mongo = null;
if (env.MONGO_ENABLE) {
  try { mongo = require('./db/mongo'); } catch (e) { console.error('[mongo] load err:', e.message); }
}

const PAPER_DIR = process.env.PAPER_DIR || path.join(process.cwd(), 'paper_outputs');

function ensureDir() {
  if (!fs.existsSync(PAPER_DIR)) fs.mkdirSync(PAPER_DIR, { recursive: true });
}
function appendCSV(filename, row, headerOrder) {
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
function toTs(s) { const t = Date.parse(s || ''); return Number.isFinite(t) ? t : Date.now(); }

async function addEntry(open) {
  // enrich
  const doc = {
    ...open,
    entryTs: toTs(open.entryTime),
    createdAt: new Date(toTs(open.entryTime)),
  };
  // CSV
  appendCSV('paper_entries.csv', {
    ...doc,
  }, [
    'posId','symbol','timeframe','side',
    'entryTime','entryTs','entryPlan','entryExec','qty',
    'equityBefore','slipBps','reason'
  ]);
  // Mongo
  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_ENTRIES);
      await coll.insertOne(doc);
    } catch (e) { console.error('[mongo] addEntry err:', e.message); }
  }
}

async function addExit(ev) {
  const doc = {
    ...ev,
    exitTs: toTs(ev.exitTime),
    createdAt: new Date(toTs(ev.exitTime)),
  };
  appendCSV('paper_exits.csv', {
    ...doc,
  }, [
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

async function addTrade(trade) {
  const doc = {
    ...trade,
    entryTs: toTs(trade.entryTime),
    exitTs: toTs(trade.exitTime),
    createdAt: new Date(toTs(trade.exitTime || trade.entryTime)),
  };
  appendCSV('paper_trades.csv', {
    ...doc,
  }, [
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
}

async function addEquityPoint(point) {
  const doc = { ...point, time: Number(point.time) };
  appendCSV('paper_equity.csv', doc, ['time','equity']);
  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_EQUITY);
      await coll.insertOne({ ...doc, createdAt: new Date(Number(doc.time) || Date.now()) });
    } catch (e) { console.error('[mongo] addEquityPoint err:', e.message); }
  }
}

async function addPositionSnapshot(pos) {
  const doc = { ...pos, snapshotTs: Date.now() };
  appendCSV('paper_positions.csv', doc, ['time','symbol','side','qty','entryExec','stop','tp1','tp2','snapshotTs']);
  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_POSITIONS);
      await coll.insertOne({ ...doc, createdAt: new Date() });
    } catch (e) { console.error('[mongo] addPositionSnapshot err:', e.message); }
  }
}

module.exports = { addEntry, addExit, addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
