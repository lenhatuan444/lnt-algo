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

// --- In-memory journals for XLSX export ---
const mem = {
  equity: [],   // { time, equity }
  trades: [],   // { ...trade fields incl. pnl, equityAfter ... }
  lastExportAt: 0,
};

function safeParseCsvLine(line) {
  // appends CSV values generated via JSON.stringify for each field -> safe to split by comma at top-level
  // We'll parse by scanning and honoring quotes.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // toggle quote unless escaped
      const prev = line[i-1];
      if (prev !== '\\') inQ = !inQ;
      cur += ch;
    } else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(v => {
    try { return JSON.parse(v); } catch { return v; }
  });
}

function readCsvToJson(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8').trim();
  if (!txt) return [];
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const parts = safeParseCsvLine(raw);
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = parts[j];
    rows.push(obj);
  }
  return rows;
}

function maxDrawdownFromEquity(arr) {
  let peak = -Infinity, maxDD = 0;
  for (const e of arr) {
    const val = e.equity ?? e;
    peak = Math.max(peak, val);
    maxDD = Math.max(maxDD, peak - val);
  }
  return maxDD;
}

async function exportPaperXlsx(baseName) {
  // Lazy require
  let XLSX; try { XLSX = require('xlsx'); } catch (e) {
    console.error('[xlsx] not installed. npm i xlsx --save', e.message);
    return null;
  }
  // Source data from memory, fallback CSV
  const eqMem = mem.equity.slice();
  const trMem = mem.trades.slice();
  const eqCsv = readCsvToJson(path.join(PAPER_DIR, 'paper_equity.csv'));
  const trCsv = readCsvToJson(path.join(PAPER_DIR, 'paper_trades.csv'));

  const equityRows = (eqMem.length ? eqMem : eqCsv).map((e, i) => ({
    index: i + 1,
    time: e.time,
    equity: Number(e.equity),
  }));

  const tradesRows = (trMem.length ? trMem : trCsv).map(t => ({
    ...t,
    pnl: Number(t.pnl ?? 0),
    equityAfter: Number(t.equityAfter ?? 0),
  }));

  const startEq = equityRows.length ? Number(equityRows[0].equity) : Number(process.env.EQUITY || env.EQUITY || 10000);
  const endEq = equityRows.length ? Number(equityRows[equityRows.length-1].equity) : startEq;
  const pnl$ = endEq - startEq;
  const wins = tradesRows.filter(t => Number(t.pnl) > 0).length;
  const losses = tradesRows.filter(t => Number(t.pnl) < 0).length;
  const totalTrades = tradesRows.length;
  const winrate = totalTrades ? (wins/totalTrades*100) : 0;
  const mdd$ = equityRows.length ? maxDrawdownFromEquity(equityRows) : 0;

  const summary = [{
    startEquity: +startEq.toFixed(2),
    endEquity: +endEq.toFixed(2),
    pnl$: +pnl$.toFixed(2),
    winratePct: +winrate.toFixed(2),
    wins, losses, totalTrades,
    maxDrawdown$: +mdd$.toFixed(2),
  }];

  const wb = XLSX.utils.book_new();
  const tradesSheet = XLSX.utils.json_to_sheet(tradesRows);
  const equitySheet = XLSX.utils.json_to_sheet(equityRows);
  const summarySheet = XLSX.utils.json_to_sheet(summary);
  XLSX.utils.book_append_sheet(wb, tradesSheet, 'trades');
  XLSX.utils.book_append_sheet(wb, equitySheet, 'equity_curve');
  XLSX.utils.book_append_sheet(wb, summarySheet, 'summary');

  const stamp = new Date().toISOString().replace(/[-:T]/g,'').slice(0,12);
  const base = String(baseName || process.env.PAPER_XLSX_BASENAME || 'paper').replace(/[^a-zA-Z0-9_-]/g,'');
  const latestPath = path.join(PAPER_DIR, `${base}.xlsx`);
  const snapshotPath = path.join(PAPER_DIR, `${base}_${stamp}.xlsx`);
  try {
    XLSX.writeFile(wb, latestPath);
    if (String(process.env.PAPER_XLSX_SNAPSHOTS || env.PAPER_XLSX_SNAPSHOTS || '0') === '1') {
      XLSX.writeFile(wb, snapshotPath);
    }
    console.log(`[xlsx] wrote ${latestPath}`);
    return latestPath;
  } catch (e) {
    console.error('[xlsx] write err:', e.message);
    return null;
  }
}

// ---- Equity simulation state ----
let equityState = { loaded: false, equity: 0 };

function readLastEquityFromCSV() {
  try {
    const p = path.join(PAPER_DIR, 'paper_equity.csv');
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, 'utf8').trim();
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return null; // only header
    const last = lines[lines.length - 1];
    const parts = last.split(',');
    const eqStr = parts[1];
    const eq = eqStr ? JSON.parse(eqStr) : null;
    return typeof eq === 'number' ? eq : (eq ? Number(eq) : null);
  } catch (e) {
    console.error('[equity] read last error:', e.message);
    return null;
  }
}

function ensureEquityLoaded() {
  if (equityState.loaded) return;
  const start = Number(process.env.EQUITY || env.EQUITY || 10000);
  const last = readLastEquityFromCSV();
  equityState.equity = (last != null && isFinite(last)) ? last : start;
  equityState.loaded = true;
}


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

  // === Compute PnL USD/% and update equity ===
  ensureEquityLoaded();
  const side = String(doc.side || '').toLowerCase();
  const entry = Number(doc.entryExec || 0);
  const exitPx = Number(doc.price || doc.exitAvg || 0);
  const qty = Number(doc.qty || 0);
  const lev = Number(doc.leverage || process.env.LEVERAGE || env.LEVERAGE || 1);
  const useLev = Number(doc.paperUseLeverage || process.env.PAPER_USE_LEVERAGE || env.PAPER_USE_LEVERAGE || 0) ? 1 : 0;

  // Prefer engine-provided pnlDelta if available
  const gross = side === 'buy' ? (exitPx - entry) * qty : (entry - exitPx) * qty;
  const pnlUsd = (typeof doc.pnlDelta === 'number' && isFinite(doc.pnlDelta)) ? Number(doc.pnlDelta) : gross;

  const notional = Math.abs(entry * qty);
  const marginUsed = useLev ? (notional / Math.max(1, lev)) : notional;
  const pnlPctOnMargin = marginUsed > 0 ? (pnlUsd / marginUsed * 100) : 0;
  const pnlPctOnEquity = (equityState.equity > 0) ? (pnlUsd / equityState.equity * 100) : 0;

  doc.equityBefore = +equityState.equity.toFixed(6);
  equityState.equity = equityState.equity + pnlUsd;
  doc.equityAfter = +equityState.equity.toFixed(6);
  doc.pnlUsd = +pnlUsd.toFixed(6);
  doc.pnlPctOnMargin = +pnlPctOnMargin.toFixed(6);
  doc.pnlPctOnEquity = +pnlPctOnEquity.toFixed(6);

  try {
    await addEquityPoint({ time: doc.exitTime || doc.createdAt || Date.now(), equity: doc.equityAfter });
  } catch (e) { console.error('[equity] add point err:', e.message); }

  // Augment leverage flags
  if (doc.paperUseLeverage == null) doc.paperUseLeverage = Number(process.env.PAPER_USE_LEVERAGE || (env.PAPER_USE_LEVERAGE || 0));
  if (doc.leverage == null) doc.leverage = Number(process.env.LEVERAGE || (env.LEVERAGE || 1));
  doc.pnlIncludesLeverage = Number(doc.paperUseLeverage ? 1 : 0);

  appendCSV('paper_exits.csv', doc, [
    'posId','symbol','timeframe','side',
    'label','fraction','price','qty','pnlDelta',
    'entryExec','entryTime','exitTime','exitTs',
    'equityBefore','equityAfter','pnlUsd','pnlPctOnMargin','pnlPctOnEquity',
    'slipBps','paperUseLeverage','leverage','pnlIncludesLeverage'
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
  try { mem.trades.push(trade); } catch {}

  const entryTs = parseTs(trade.entryTime);
  const exitTs  = parseTs(trade.exitTime);
  const doc = {
    ...trade,
    entryTs,
    exitTs,
    createdAt: new Date(exitTs || entryTs),
  };
  if (doc.paperUseLeverage == null) doc.paperUseLeverage = Number(process.env.PAPER_USE_LEVERAGE || (env.PAPER_USE_LEVERAGE || 0));
  if (doc.leverage == null) doc.leverage = Number(process.env.LEVERAGE || (env.LEVERAGE || 1));
  doc.pnlIncludesLeverage = Number(doc.paperUseLeverage ? 1 : 0);


  appendCSV('paper_trades.csv', doc, [
    'posId','symbol','timeframe','side',
    'entryTime','entryTs','entryPlan','entryExec',
    'exitTime','exitTs','exitAvg','qty','pnl','hits',
    'equityAfter','slipBps','paperUseLeverage','leverage','pnlIncludesLeverage'
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
  try { mem.equity.push({ time: point.time, equity: point.equity }); } catch {}

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
  if (doc.paperUseLeverage == null) doc.paperUseLeverage = Number(process.env.PAPER_USE_LEVERAGE || (env.PAPER_USE_LEVERAGE || 0));
  if (doc.leverage == null) doc.leverage = Number(process.env.LEVERAGE || (env.LEVERAGE || 1));

  appendCSV('paper_positions.csv', doc, ['time','symbol','side','qty','entryExec','stop','tp','snapshotTs','paperUseLeverage','leverage']);

  if (env.MONGO_ENABLE && mongo) {
    try {
      const coll = await mongo.getColl(env.MONGO_COLL_POSITIONS);
      await coll.insertOne({ ...doc, createdAt: new Date() });
    } catch (e) { console.error('[mongo] addPositionSnapshot err:', e.message); }
  }
}

module.exports = { addEntry, addExit, addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
