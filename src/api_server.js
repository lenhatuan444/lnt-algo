/* API to read backtest outputs (Excel first, CSV/JSON fallback)
 * Endpoints:
 *  - GET /api/health
 *  - GET /api/files
 *  - GET /api/latest/summary
 *  - GET /api/latest/trades
 *  - GET /api/latest/equity
 *  - GET /api/:file/summary
 *  - GET /api/:file/trades
 *  - GET /api/:file/equity
 * Query params: limit, offset, sort, order, symbol, side, from, to, normalize, format=csv
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { env } = require('./config');

const app = express();

// ENV (from config.js)
const PORT = env.API_PORT;
const DATA_DIR = path.isAbsolute(env.BACKTEST_DIR) ? env.BACKTEST_DIR : path.join(process.cwd(), env.BACKTEST_DIR);
const CORS_ORIGIN = env.CORS_ORIGIN;
const API_DEFAULT_LIMIT = Math.max(1, env.API_DEFAULT_LIMIT);
const API_MAX_LIMIT = Math.max(API_DEFAULT_LIMIT, env.API_MAX_LIMIT);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// ---------- helpers ----------
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
  return Object.values(groups).sort((a,b)=>b.mtimeMs-a.mtimeMs);
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

function csvToJson(file) {
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
      try { val = JSON.parse(raw); } catch(_) {}
      obj[headers[j]] = val;
    }
    rows.push(obj);
  }
  return rows;
}

function toCsv(rows) {
  if (!Array.isArray(rows)) {
    const keys = Object.keys(rows || {});
    return keys.join(',') + '\n' + keys.map(k => JSON.stringify(rows[k] ?? '')).join(',') + '\n';
  }
  if (!rows.length) return '\n';
  const keys = Object.keys(rows[0]);
  const out = [keys.join(',')];
  for (const r of rows) out.push(keys.map(k => JSON.stringify(r[k] ?? '')).join(','));
  return out.join('\n') + '\n';
}

function wantsCsv(req) {
  const q = String(req.query.format || '').toLowerCase();
  const accept = (req.headers['accept'] || '').toLowerCase();
  return q === 'csv' || accept.includes('text/csv');
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
function sliceOnly(arr, {limit, offset}) {
  return arr.slice(clampOffset(offset), clampOffset(offset) + clampLimit(limit));
}
function sortAndSlice(arr, {limit, offset, sort, order}) {
  let out = arr.slice();
  if (sort) {
    const ord = (String(order||'desc').toLowerCase() === 'asc') ? 1 : -1;
    out.sort((a,b) => {
      const av = a[sort]; const bv = b[sort];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (!isNaN(av) && !isNaN(bv)) return ord * (Number(av) - Number(bv));
      return ord * String(av).localeCompare(String(bv));
    });
  }
  return sliceOnly(out, {limit, offset});
}

function filterTrades(rows, {symbol, side, from, to}) {
  let out = rows;
  if (symbol) out = out.filter(r => String(r.symbol || '').toUpperCase().includes(String(symbol).toUpperCase()));
  if (side)   out = out.filter(r => String(r.side || '').toLowerCase() === String(side).toLowerCase());
  if (from) { const f = Date.parse(from); out = out.filter(r => Date.parse(r.entryTime || 0) >= f); }
  if (to)   { const t = Date.parse(to);   out = out.filter(r => Date.parse(r.entryTime || 0) <= t); }
  return out;
}

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
        const {symbol, side, from, to, limit, offset, sort, order} = q;
        const wb = XLSX.readFile(group.xlsxPath);
        const sheet = wb.Sheets['trades'] || wb.Sheets[wb.SheetNames.find(n => /trade/i.test(n))];
        if (!sheet) return [];
        let arr = XLSX.utils.sheet_to_json(sheet, { defval: null });
        arr = filterTrades(arr, {symbol, side, from, to});
        return sortAndSlice(arr, {limit, offset, sort, order});
      },
      equity(q) {
        const {normalize, limit, offset} = q;
        const wb = XLSX.readFile(group.xlsxPath);
        const sheet = wb.Sheets['equity_curve'] || wb.Sheets[wb.SheetNames.find(n => /equity/i.test(n))];
        if (!sheet) return [];
        let arr = XLSX.utils.sheet_to_json(sheet, { defval: null });
        if (normalize && arr.length) {
          const e0 = arr[0].equity ?? arr[0].Equity;
          arr = arr.map(r => ({ index: r.index ?? r.Index, equity: r.equity ?? r.Equity, norm: (r.equity ?? r.Equity) / e0 }));
        }
        return sliceOnly(arr, {limit, offset});
      }
    };
  }
  return {
    type: 'csv+json',
    summary() {
      if (!group.summaryJson) return {};
      try { return JSON.parse(fs.readFileSync(group.summaryJson, 'utf8')); } catch { return {}; }
    },
    trades(q) {
      const {symbol, side, from, to, limit, offset, sort, order} = q;
      if (!group.tradesCsv) return [];
      let arr = csvToJson(group.tradesCsv);
      arr = filterTrades(arr, {symbol, side, from, to});
      return sortAndSlice(arr, {limit, offset, sort, order});
    },
    equity(q) {
      const {normalize, limit, offset} = q;
      if (!group.equityCsv) return [];
      let arr = csvToJson(group.equityCsv);
      if (normalize && arr.length) {
        const e0 = Number(arr[0].equity);
        arr = arr.map(r => ({ index: Number(r.index), equity: Number(r.equity), norm: Number(r.equity)/e0 }));
      }
      return sliceOnly(arr, {limit, offset});
    }
  };
}

// ---------- routes ----------
app.get('/api/health', (req,res)=> res.json({
  ok: true, dataDir: DATA_DIR, defaultLimit: API_DEFAULT_LIMIT, maxLimit: API_MAX_LIMIT
}));

app.get('/api/files', (req,res)=> res.json({ files: listGroups() }));

// latest

app.get('/api/latest/:kind', (req, res) => {
  const allowedKinds = ['summary', 'trades', 'equity'];
  if (!allowedKinds.includes(req.params.kind)) return res.status(404).send('Invalid kind');
  const g = getGroup('latest');
  if (!g) return res.status(404).json({ error: 'No backtest files found' });
  const reader = makeReader(g);
  const q = req.query;
  const normalize = q.normalize === '1' || q.normalize === 'true';
  let data = [];
  if (req.params.kind === 'summary') data = reader.summary();
  if (req.params.kind === 'trades')  data = reader.trades(q);
  if (req.params.kind === 'equity')  data = reader.equity({ normalize, limit: q.limit, offset: q.offset });

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${g.id}_${req.params.kind}.csv`);
    return res.send(toCsv(data));
  }
  res.json({ file: g.id, kind: req.params.kind, data, pagination: { defaultLimit: API_DEFAULT_LIMIT, maxLimit: API_MAX_LIMIT } });
});

// by file id

app.get('/api/:file/:kind', (req, res) => {
  const allowedKinds = ['summary', 'trades', 'equity'];
  if (!allowedKinds.includes(req.params.kind)) return res.status(404).send('Invalid kind');
  const g = getGroup(req.params.file);
  if (!g) return res.status(404).json({ error: 'File not found' });
  const reader = makeReader(g);
  const q = req.query;
  const normalize = q.normalize === '1' || q.normalize === 'true';
  let data = [];
  if (req.params.kind === 'summary') data = reader.summary();
  if (req.params.kind === 'trades')  data = reader.trades(q);
  if (req.params.kind === 'equity')  data = reader.equity({ normalize, limit: q.limit, offset: q.offset });

  if (wantsCsv(req)) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=${g.id}_${req.params.kind}.csv`);
    return res.send(toCsv(data));
  }
  res.json({ file: g.id, kind: req.params.kind, data, pagination: { defaultLimit: API_DEFAULT_LIMIT, maxLimit: API_MAX_LIMIT } });
});

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} | DATA_DIR=${DATA_DIR} | defaultLimit=${API_DEFAULT_LIMIT} maxLimit=${API_MAX_LIMIT}`);
});
