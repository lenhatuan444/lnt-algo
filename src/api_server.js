/* API server: backtest outputs (xlsx/csv/json) + PAPER outputs (Mongo or CSV)
 * Express v5 compatible routes.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { env, sanitizeSid, STRATEGY, fileFor } = require('./config');
const watch = require('./rt_watch');

const app = express();

// ===== ENV =====
const PORT = Number(process.env.API_PORT || 8080);
const DATA_DIR = process.env.BACKTEST_DIR || path.join(process.cwd(), 'backtest_outputs');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const API_DEFAULT_LIMIT = Math.max(1, Number(process.env.API_DEFAULT_LIMIT || 100));
const API_MAX_LIMIT = Math.max(API_DEFAULT_LIMIT, Number(process.env.API_MAX_LIMIT || 1000));

// Paper outputs dir
let PAPER_DIR = process.env.PAPER_DIR || path.join(process.cwd(), 'paper_outputs');

app.use(cors({ origin: CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));

// ===== Mongo helpers =====
let mongo = null;
if (env.MONGO_ENABLE) {
  try {
    mongo = require('./db/mongo');
    mongo.ensureIndexes().catch(()=>{});
    console.log('[api] Mongo enabled');
  } catch (e) {
    console.error('[api] Mongo load error:', e.message);
  }
}

async function mongoQuery(collBase, sid, { filter = {}, sort = {}, limit = API_DEFAULT_LIMIT, offset = 0 } = {}) {
  const coll = await mongo.getColl(collBase, sid);
  const total = await coll.countDocuments(filter);
  const cursor = coll.find(filter).sort(sort).skip(offset).limit(limit);
  const data = await cursor.toArray();
  return { total, data };
}

// ===== Helpers (backtest files) =====
function listGroups() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const files = fs.readdirSync(DATA_DIR);
  const groups = {};
  for (const name of files) {
    const full = path.join(DATA_DIR, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;

    if (name.endsWith('.xlsx')) {
      const id = name.slice(0, -5);
      groups[id] = groups[id] || { id, mtimeMs: 0, size: 0 };
      groups[id].xlsxPath = full;
      groups[id].mtimeMs = Math.max(groups[id].mtimeMs, st.mtimeMs);
      groups[id].size += st.size;
      continue;
    }
    if (name.endsWith('_trades.csv')) {
      const id = name.slice(0, -12);
      groups[id] = groups[id] || { id, mtimeMs: 0, size: 0 };
      groups[id].tradesCsv = full;
      groups[id].mtimeMs = Math.max(groups[id].mtimeMs, st.mtimeMs);
      groups[id].size += st.size;
      continue;
    }
    if (name.endsWith('_equity.csv')) {
      const id = name.slice(0, -12);
      groups[id] = groups[id] || { id, mtimeMs: 0, size: 0 };
      groups[id].equityCsv = full;
      groups[id].mtimeMs = Math.max(groups[id].mtimeMs, st.mtimeMs);
      groups[id].size += st.size;
      continue;
    }
    if (name.endsWith('_summary.json')) {
      const id = name.slice(0, -14);
      groups[id] = groups[id] || { id, mtimeMs: 0, size: 0 };
      groups[id].summaryJson = full;
      groups[id].mtimeMs = Math.max(groups[id].mtimeMs, st.mtimeMs);
      groups[id].size += st.size;
      continue;
    }
  }
  return Object.values(groups).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getGroup(idOrLatest) {
  const list = listGroups();
  if (!list.length) return null;
  const id = (idOrLatest === 'latest') ? list[0].id : idOrLatest;
  const g = {
    id,
    xlsxPath: path.join(DATA_DIR, id + '.xlsx'),
    tradesCsv: path.join(DATA_DIR, id + '_trades.csv'),
    equityCsv: path.join(DATA_DIR, id + '_equity.csv'),
    summaryJson: path.join(DATA_DIR, id + '_summary.json'),
  };
  for (const k of Object.keys(g)) {
    if (k === 'id') continue;
    if (!fs.existsSync(g[k])) g[k] = null;
  }
  return g;
}

// ===== CSV / JSON utils =====
function csvToJson(file) {
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      const raw = parts[j] ?? '';
      let val = raw;
      try { val = JSON.parse(raw); } catch (_) {}
      obj[headers[j]] = val;
    }
    rows.push(obj);
  }
  return rows;
}

function toCsv(rows) {
  if (!Array.isArray(rows)) {
    const keys = Object.keys(rows || {});
    const header = keys.join(',');
    const values = keys.map(k => JSON.stringify(rows[k] ?? '')).join(',');
    return header + '\n' + values + '\n';
  }
  if (!rows.length) return '\n';
  const keys = Object.keys(rows[0]);
  const header = keys.join(',');
  const lines = [header];
  for (const r of rows) {
    lines.push(keys.map(k => JSON.stringify(r[k] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function wantsCsv(req) {
  const q = String(req.query.format || '').toLowerCase();
  const accept = (req.headers['accept'] || '').toLowerCase();
  return q === 'csv' || accept.includes('text/csv') || req.path.endsWith('.csv');
}

function clampLimit(limit) {
  let lim = Number(limit);
  if (!Number.isFinite(lim) || lim <= 0) lim = API_DEFAULT_LIMIT;
  if (lim > API_MAX_LIMIT) lim = API_MAX_LIMIT;
  return Math.floor(lim);
}
function clampOffset(offset) {
  let off = Number(offset);
  if (!Number.isFinite(off) || off < 0) off = 0;
  return Math.floor(off);
}
function sliceOnly(arr, { limit, offset }) {
  const off = clampOffset(offset);
  const lim = clampLimit(limit);
  return arr.slice(off, off + lim);
}
function sortAndSlice(arr, { limit, offset, sort, order }) {
  let out = arr.slice();
  if (sort) {
    const ord = (String(order || 'desc').toLowerCase() === 'asc') ? 1 : -1;
    out.sort((a, b) => {
      const av = a[sort]; const bv = b[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (!isNaN(av) && !isNaN(bv)) return ord * (Number(av) - Number(bv));
      return ord * String(av).localeCompare(String(bv));
    });
  }
  return sliceOnly(out, { limit, offset });
}

// ===== Validators =====
const KINDS = new Set(['summary', 'trades', 'equity']);
function assertKind(kind, res) {
  if (!KINDS.has(kind)) {
    res.status(400).json({ error: 'Invalid kind. Use one of: summary, trades, equity' });
    return false;
  }
  return true;
}

// ===== Routes =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    paperDir: PAPER_DIR,
    defaultLimit: API_DEFAULT_LIMIT,
    maxLimit: API_MAX_LIMIT,
    mongo: !!env.MONGO_ENABLE,
    strategy: sanitizeSid(req.query.strategy || STRATEGY)
  });
});

app.get('/api/files', (req, res) => {
  res.json({ files: listGroups() });
});

// ---- Latest (JSON/CSV) ----
function handleLatest(req, res) {
  const kind = req.params.kind;
  if (!assertKind(kind, res)) return;

  const g = getGroup('latest');
  if (!g) return res.status(404).json({ error: 'No backtest files found' });

  const normalize = (req.query.normalize === '1' || req.query.normalize === 'true');

  let data;
  if (kind === 'summary') {
    const wb = g.xlsxPath && XLSX.readFile(g.xlsxPath);
    const sheet = wb && (wb.Sheets['summary'] || wb.Sheets[wb.SheetNames.find(n => /summary/i.test(n))]);
    data = sheet ? (XLSX.utils.sheet_to_json(sheet, { defval: null })[0] || {}) : {};
  }
  if (kind === 'trades')  {
    const wb = g.xlsxPath && XLSX.readFile(g.xlsxPath);
    const sheet = wb && (wb.Sheets['trades'] || wb.Sheets[wb.SheetNames.find(n => /trade/i.test(n))]);
    data = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : (g.tradesCsv ? csvToJson(g.tradesCsv) : []);
    data = sortAndSlice(data, req.query);
  }
  if (kind === 'equity')  {
    const wb = g.xlsxPath && XLSX.readFile(g.xlsxPath);
    const sheet = wb && (wb.Sheets['equity_curve'] || wb.Sheets[wb.SheetNames.find(n => /equity/i.test(n))]);
    data = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : (g.equityCsv ? csvToJson(g.equityCsv) : []);
    if (normalize && data.length) {
      const e0 = data[0].equity ?? data[0].Equity;
      data = data.map(r => ({ index: r.index ?? r.Index, equity: r.equity ?? r.Equity, norm: e0 ? (r.equity ?? r.Equity) / e0 : null }));
    }
    data = sliceOnly(data, req.query);
  }

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${g.id}_${kind}.csv`);
    return res.send(toCsv(Array.isArray(data)?data:[data]));
  }
  res.json({ file: g.id, kind, data, pagination: { defaultLimit: API_DEFAULT_LIMIT, maxLimit: API_MAX_LIMIT } });
}
app.get('/api/latest/:kind', handleLatest);
app.get('/api/latest/:kind.csv', handleLatest);

/* ========= PAPER API ========= */
function readCsvMaybe(p) {
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      let v = parts[j] ?? '';
      try { v = JSON.parse(v); } catch {}
      obj[headers[j]] = v;
    }
    rows.push(obj);
  }
  return rows;
}

function countCsvRows(p) {
  if (!fs.existsSync(p)) return 0;
  const text = fs.readFileSync(p, 'utf8');
  if (!text) return 0;
  const n = (text.match(/\r?\n/g) || []).length;
  return Math.max(0, n - 1);
}

function listPaperFiles(sid) {
  if (!fs.existsSync(PAPER_DIR)) return [];
  const names = fs.readdirSync(PAPER_DIR).filter(n => n.endsWith('.csv') && n.startsWith(sanitizeSid(sid) + '_'));
  const out = [];
  for (const name of names) {
    const full = path.join(PAPER_DIR, name);
    const st = fs.statSync(full);
    out.push({ name, size: st.size, mtimeMs: st.mtimeMs, rows: countCsvRows(full) });
  }
  out.sort((a,b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// /api/paper/files
app.get('/api/paper/files', (req, res) => {
  const sid = sanitizeSid(req.query.strategy || STRATEGY);
  res.json({ dir: PAPER_DIR, strategy: sid, files: listPaperFiles(sid) });
});

// /api/paper/file/:name
app.get('/api/paper/file/:name', (req, res) => {
  const name = path.basename(req.params.name || '');
  if (!name || name.includes('..') || name.includes('/') || !name.endsWith('.csv')) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  const file = path.join(PAPER_DIR, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=${name}`);
  res.sendFile(file);
});

async function handleMongoOrCsv(req, res, kind) {
  const sid = sanitizeSid(req.query.strategy || STRATEGY);
  const { symbol, side, label, posId, from, to, sort, order='desc', limit, offset, normalize } = req.query;
  const ord = (String(order).toLowerCase() === 'asc') ? 1 : -1;
  const lim = (n)=> Math.floor(Math.max(1, Math.min(API_MAX_LIMIT, Number(n)||API_DEFAULT_LIMIT)));
  const off = (n)=> Math.floor(Math.max(0, Number(n)||0));

  if (env.MONGO_ENABLE && mongo) {
    const base = (kind==='entries'?'entries': kind==='exits'?'exits': kind==='history'?'trades': kind==='equity'?'equity':'entries');
    const filter = {};
    if (symbol) filter.symbol = { $regex: String(symbol), $options: 'i' };
    if (side) filter.side = String(side).toLowerCase();
    if (label && base==='exits') filter.label = String(label).toUpperCase();
    if (posId && (base==='exits' || base==='trades')) filter.posId = String(posId);
    if (from || to) {
      const fKey = (base==='entries' || base==='trades') ? 'entryTs' : (base==='exits' ? 'exitTs' : 'timeTs');
      filter[fKey] = {};
      if (from) filter[fKey].$gte = Date.parse(from);
      if (to)   filter[fKey].$lte = Date.parse(to);
    }
    const sKey = sort || (base==='equity' ? 'time' : (base==='entries'?'entryTs': base==='exits'?'exitTs':'exitTs'));
    const { total, data } = await mongoQuery(base, sid, { filter, sort: { [sKey]: ord }, limit: lim(limit), offset: off(offset) });
    let rows = data;
    if (base==='equity' && (normalize==='1' || normalize==='true') && rows.length){
      const e0 = Number(rows[rows.length-1]?.equity || rows[0]?.equity);
      rows = rows.map(r => ({ ...r, norm: e0 ? Number(r.equity)/e0 : null }));
    }
    if (wantsCsv(req)) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=${sid}_paper_${base}.csv`);
      return res.send(toCsv(rows));
    }
    return res.json({ kind: `paper_${base}`, strategy: sid, total, limit: lim(limit), offset: off(offset), data: rows });
  }

  // CSV fallback
  const file = path.join(PAPER_DIR, fileFor(kind==='history'?'trades':kind, sid));
  let rows = readCsvMaybe(file);

  // filter & sort
  if (symbol) rows = rows.filter(r => String(r.symbol || '').toUpperCase().includes(String(symbol).toUpperCase()));
  if (side)   rows = rows.filter(r => String(r.side || '').toLowerCase() === String(side).toLowerCase());
  if (label && kind==='exits') rows = rows.filter(r => String(r.label || '').toUpperCase() === String(label).toUpperCase());
  if (posId && (kind==='exits' || kind==='history')) rows = rows.filter(r => String(r.posId || '') === String(posId));
  if (from) { const t = Date.parse(from); rows = rows.filter(r => Date.parse(r.entryTime || r.exitTime || r.time || 0) >= t); }
  if (to)   { const t = Date.parse(to);   rows = rows.filter(r => Date.parse(r.entryTime || r.exitTime || r.time || 0) <= t); }

  const s = sort || (kind==='equity' ? 'time' : (kind==='entries'?'entryTime': kind==='exits'?'exitTime':'exitTime'));
  rows.sort((a, b) => {
    const av = a[s]; const bv = b[s];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (!isNaN(av) && !isNaN(bv)) return ord * (Number(av) - Number(bv));
    return ord * String(av).localeCompare(String(bv));
  });

  const page = rows.slice(off(offset), off(offset)+lim(limit));
  if (kind==='equity' && (normalize==='1' || normalize==='true') && page.length){
    const e0 = Number(page[0].equity);
    for (const r of page) r.norm = e0 ? Number(r.equity)/e0 : null;
  }

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${sid}_paper_${kind}.csv`);
    return res.send(toCsv(page));
  }
  res.json({ kind: `paper_${kind}`, strategy: sid, total: rows.length, limit: lim(limit), offset: off(offset), data: page });
}

// entries
app.get(['/api/paper/entries', '/api/paper/entries.csv'], (req, res) => handleMongoOrCsv(req, res, 'entries'));
// exits
app.get(['/api/paper/exits', '/api/paper/exits.csv'], (req, res) => handleMongoOrCsv(req, res, 'exits'));
// history (closed trades)
app.get(['/api/paper/history', '/api/paper/history.csv'], (req, res) => handleMongoOrCsv(req, res, 'history'));
// equity
app.get(['/api/paper/equity', '/api/paper/equity.csv'], (req, res) => handleMongoOrCsv(req, res, 'equity'));
// positions (state)
app.get('/api/paper/positions', async (req, res) => {
  const sid = sanitizeSid(req.query.strategy || STRATEGY);
  if (env.MONGO_ENABLE && mongo){
    try {
      const db = await mongo.getDb();
      const coll = await mongo.getColl('state', sid);
      const doc = await coll.findOne({ _id: 'singleton' });
      const positions = doc?.state?.paper?.positions || [];
      return res.json({ kind: 'paper_positions', strategy: sid, data: positions });
    } catch(e){
      console.error('positions mongo error:', e.message);
    }
  }
  try {
    const name = fileFor('state', sid);
    const state = JSON.parse(fs.readFileSync(path.join(process.cwd(), name), 'utf8'));
    const positions = (state.paper && Array.isArray(state.paper.positions)) ? state.paper.positions : [];
    res.json({ kind: 'paper_positions', strategy: sid, data: positions });
  } catch {
    res.json({ kind: 'paper_positions', strategy: sid, data: [] });
  }
});

// RT watch endpoints
app.get('/api/rt/watch', (req, res) => {
  const sid = sanitizeSid(req.query.strategy || STRATEGY);
  return res.json({ strategy: sid, mode: env.RT_WATCH_MODE, manual: watch.get(sid) });
});
app.post('/api/rt/watch', (req, res) => {
  const sid = sanitizeSid(req.query.strategy || STRATEGY);
  const action = String(req.body.action || '').toLowerCase();
  const symbols = Array.isArray(req.body.symbols) ? req.body.symbols : [];
  let manual;
  if (action === 'add') manual = watch.add(symbols, sid);
  else if (action === 'remove') manual = watch.remove(symbols, sid);
  else if (action === 'set') manual = watch.setAll(symbols, sid);
  else return res.status(400).json({ error: 'action must be add|remove|set' });
  return res.json({ strategy: sid, mode: env.RT_WATCH_MODE, manual });
});

/* ================== BACKTEST BY FILE ================== */
function handleByFile(req, res) {
  const kind = req.params.kind;
  if (!assertKind(kind, res)) return;

  const g = getGroup(req.params.file);
  if (!g) return res.status(404).json({ error: 'File not found' });

  const q = req.query;
  const normalize = q.normalize === '1' || q.normalize === 'true';

  let data;
  if (kind === 'summary') {
    const wb = g.xlsxPath && XLSX.readFile(g.xlsxPath);
    const sheet = wb && (wb.Sheets['summary'] || wb.Sheets[wb.SheetNames.find(n => /summary/i.test(n))]);
    data = sheet ? (XLSX.utils.sheet_to_json(sheet, { defval: null })[0] || {}) : {};
  }
  if (kind === 'trades')  {
    const wb = g.xlsxPath && XLSX.readFile(g.xlsxPath);
    const sheet = wb && (wb.Sheets['trades'] || wb.Sheets[wb.SheetNames.find(n => /trade/i.test(n))]);
    data = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : (g.tradesCsv ? csvToJson(g.tradesCsv) : []);
    data = sortAndSlice(data, q);
  }
  if (kind === 'equity')  {
    const wb = g.xlsxPath && XLSX.readFile(g.xlsxPath);
    const sheet = wb && (wb.Sheets['equity_curve'] || wb.Sheets[wb.SheetNames.find(n => /equity/i.test(n))]);
    data = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : (g.equityCsv ? csvToJson(g.equityCsv) : []);
    if (normalize && data.length) {
      const e0 = data[0].equity ?? data[0].Equity;
      data = data.map(r => ({ index: r.index ?? r.Index, equity: r.equity ?? r.Equity, norm: e0 ? (r.equity ?? r.Equity) / e0 : null }));
    }
    data = sliceOnly(data, q);
  }

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${g.id}_${kind}.csv`);
    return res.send(toCsv(Array.isArray(data)?data:[data]));
  }
  res.json({
    file: g.id,
    kind,
    data,
    pagination: { defaultLimit: API_DEFAULT_LIMIT, maxLimit: API_MAX_LIMIT }
  });
}
app.get('/api/:file/:kind', handleByFile);
app.get('/api/:file/:kind.csv', handleByFile);

// ===== Start =====
app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} | DATA_DIR=${DATA_DIR} | PAPER_DIR=${PAPER_DIR} | defaultLimit=${API_DEFAULT_LIMIT} maxLimit=${API_MAX_LIMIT}`);
});
