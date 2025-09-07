/* src/api_server.js
 * API đọc backtest outputs (Excel trước, CSV/JSON fallback) + Paper trading outputs.
 * Express v5 compatible (không dùng :param(...) trong route).
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const app = express();

// ===== ENV =====
const PORT = Number(process.env.API_PORT || 8080);
const DATA_DIR = process.env.BACKTEST_DIR || path.join(process.cwd(), 'backtest_outputs');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const API_DEFAULT_LIMIT = Math.max(1, Number(process.env.API_DEFAULT_LIMIT || 100));
const API_MAX_LIMIT = Math.max(API_DEFAULT_LIMIT, Number(process.env.API_MAX_LIMIT || 1000));

// Paper outputs dir (từ paper_store.js nếu tồn tại)
let PAPER_DIR = process.env.PAPER_DIR || path.join(process.cwd(), 'paper_outputs');
try {
  const paperStore = require('./paper_store');
  if (paperStore && paperStore.PAPER_DIR) PAPER_DIR = paperStore.PAPER_DIR;
} catch (_) { /* optional */ }

app.use(cors({ origin: CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));

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
function filterTrades(rows, { symbol, side, from, to }) {
  let out = rows;
  if (symbol) out = out.filter(r => String(r.symbol || '').toUpperCase().includes(String(symbol).toUpperCase()));
  if (side)   out = out.filter(r => String(r.side || '').toLowerCase() === String(side).toLowerCase());
  if (from) { const f = Date.parse(from); out = out.filter(r => Date.parse(r.entryTime || 0) >= f); }
  if (to)   { const t = Date.parse(to);   out = out.filter(r => Date.parse(r.entryTime || 0) <= t); }
  return out;
}

// ===== Reader (Excel / CSV+JSON) =====
function makeReader(group) {
  if (group.xlsxPath) {
    return {
      type: 'xlsx',
      summary() {
        const wb = XLSX.readFile(group.xlsxPath);
        const sheet = wb.Sheets['summary'] || wb.Sheets[wb.SheetNames.find(n => /summary/i.test(n))];
        if (!sheet) return {};
        const arr = XLSX.utils.sheet_to_json(sheet, { defval: null });
        return arr && arr[0] ? arr[0] : {};
      },
      trades(q) {
        const { symbol, side, from, to, limit, offset, sort, order } = q;
        const wb = XLSX.readFile(group.xlsxPath);
        const sheet = wb.Sheets['trades'] || wb.Sheets[wb.SheetNames.find(n => /trade/i.test(n))];
        if (!sheet) return [];
        let arr = XLSX.utils.sheet_to_json(sheet, { defval: null });
        arr = filterTrades(arr, { symbol, side, from, to });
        return sortAndSlice(arr, { limit, offset, sort, order });
      },
      equity(q) {
        const { normalize, limit, offset } = q;
        const wb = XLSX.readFile(group.xlsxPath);
        const sheet = wb.Sheets['equity_curve'] || wb.Sheets[wb.SheetNames.find(n => /equity/i.test(n))];
        if (!sheet) return [];
        let arr = XLSX.utils.sheet_to_json(sheet, { defval: null });
        if (normalize && arr.length) {
          const e0 = arr[0].equity ?? arr[0].Equity;
          arr = arr.map(r => ({
            index: r.index ?? r.Index,
            equity: r.equity ?? r.Equity,
            norm: e0 ? (r.equity ?? r.Equity) / e0 : null
          }));
        }
        return sliceOnly(arr, { limit, offset });
      }
    };
  }
  // fallback CSV+JSON
  return {
    type: 'csv+json',
    summary() {
      if (!group.summaryJson) return {};
      try { return JSON.parse(fs.readFileSync(group.summaryJson, 'utf8')); } catch { return {}; }
    },
    trades(q) {
      const { symbol, side, from, to, limit, offset, sort, order } = q;
      if (!group.tradesCsv) return [];
      let arr = csvToJson(group.tradesCsv);
      arr = filterTrades(arr, { symbol, side, from, to });
      return sortAndSlice(arr, { limit, offset, sort, order });
    },
    equity(q) {
      const { normalize, limit, offset } = q;
      if (!group.equityCsv) return [];
      let arr = csvToJson(group.equityCsv);
      if (normalize && arr.length) {
        const e0 = Number(arr[0].equity ?? arr[0].Equity ?? arr[0].equity);
        arr = arr.map(r => ({
          index: Number(r.index ?? r.Index),
          equity: Number(r.equity ?? r.Equity),
          norm: e0 ? Number(r.equity ?? r.Equity) / e0 : null
        }));
      }
      return sliceOnly(arr, { limit, offset });
    }
  };
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
    maxLimit: API_MAX_LIMIT
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

  const reader = makeReader(g);
  const q = req.query;
  const normalize = q.normalize === '1' || q.normalize === 'true';

  let data;
  if (kind === 'summary') data = reader.summary();
  if (kind === 'trades')  data = reader.trades(q);
  if (kind === 'equity')  data = reader.equity({ normalize, limit: q.limit, offset: q.offset });

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${g.id}_${kind}.csv`);
    return res.send(toCsv(data));
  }
  res.json({
    file: g.id,
    kind,
    data,
    pagination: { defaultLimit: API_DEFAULT_LIMIT, maxLimit: API_MAX_LIMIT }
  });
}
app.get('/api/latest/:kind', handleLatest);
app.get('/api/latest/:kind.csv', handleLatest);

// ---- By file id (JSON/CSV) ----
function handleByFile(req, res) {
  const kind = req.params.kind;
  if (!assertKind(kind, res)) return;

  const g = getGroup(req.params.file);
  if (!g) return res.status(404).json({ error: 'File not found' });

  const reader = makeReader(g);
  const q = req.query;
  const normalize = q.normalize === '1' || q.normalize === 'true';

  let data;
  if (kind === 'summary') data = reader.summary();
  if (kind === 'trades')  data = reader.trades(q);
  if (kind === 'equity')  data = reader.equity({ normalize, limit: q.limit, offset: q.offset });

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${g.id}_${kind}.csv`);
    return res.send(toCsv(data));
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

// ===== PAPER API =====
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

// /api/paper/history[.csv]
app.get(['/api/paper/history', '/api/paper/history.csv'], (req, res) => {
  const file = path.join(PAPER_DIR, 'paper_trades.csv');
  let rows = readCsvMaybe(file);

  const { symbol, side, from, to, sort = 'entryTime', order = 'desc', limit, offset } = req.query;

  if (symbol) rows = rows.filter(r => String(r.symbol || '').toUpperCase().includes(String(symbol).toUpperCase()));
  if (side)   rows = rows.filter(r => String(r.side || '').toLowerCase() === String(side).toLowerCase());
  if (from) { const t = Date.parse(from); rows = rows.filter(r => Date.parse(r.entryTime || 0) >= t); }
  if (to)   { const t = Date.parse(to);   rows = rows.filter(r => Date.parse(r.entryTime || 0) <= t); }

  // sort
  const ord = (String(order).toLowerCase() === 'asc') ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[sort]; const bv = b[sort];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (!isNaN(av) && !isNaN(bv)) return ord * (Number(av) - Number(bv));
    return ord * String(av).localeCompare(String(bv));
  });

  // paginate
  const off = clampOffset(offset);
  const lim = clampLimit(limit);
  const page = rows.slice(off, off + lim);

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=paper_history.csv');
    return res.send(toCsv(page));
  }
  res.json({ kind: 'paper_history', total: rows.length, limit: lim, offset: off, data: page });
});

// /api/paper/equity[.csv]?normalize=1
app.get(['/api/paper/equity', '/api/paper/equity.csv'], (req, res) => {
  const file = path.join(PAPER_DIR, 'paper_equity.csv');
  let rows = readCsvMaybe(file);
  const normalize = String(req.query.normalize || '').toLowerCase();
  const doNorm = normalize === '1' || normalize === 'true';

  if (doNorm && rows.length) {
    const e0 = Number(rows[0].equity);
    rows = rows.map(r => ({ ...r, norm: e0 ? Number(r.equity) / e0 : null }));
  }

  const off = clampOffset(req.query.offset);
  const lim = clampLimit(req.query.limit);
  const page = rows.slice(off, off + lim);

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=paper_equity.csv');
    return res.send(toCsv(page));
  }
  res.json({ kind: 'paper_equity', total: rows.length, limit: lim, offset: off, data: page });
});

// /api/paper/positions
app.get('/api/paper/positions', (req, res) => {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'bot_state.json'), 'utf8'));
    const positions = (state.paper && Array.isArray(state.paper.positions)) ? state.paper.positions : [];
    res.json({ kind: 'paper_positions', data: positions });
  } catch {
    res.json({ kind: 'paper_positions', data: [] });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} | DATA_DIR=${DATA_DIR} | PAPER_DIR=${PAPER_DIR} | defaultLimit=${API_DEFAULT_LIMIT} maxLimit=${API_MAX_LIMIT}`);
});
