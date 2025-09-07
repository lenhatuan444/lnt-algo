// src/paper_store.js
const fs = require('fs');
const path = require('path');

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

// 🔹 Lưu ENTRY ngay khi mở lệnh paper (có posId)
function addEntry(open) {
  appendCSV('paper_entries.csv', open, [
    'posId','symbol','timeframe','side',
    'entryTime','entryPlan','entryExec','qty',
    'equityBefore','slipBps','reason'
  ]);
}

// 🔹 Lưu mỗi lần EXIT (partial hoặc full) với P&L delta và lý do (label)
function addExit(ev) {
  appendCSV('paper_exits.csv', ev, [
    'posId','symbol','timeframe','side',
    'label','fraction','price','qty','pnlDelta',
    'entryExec','entryTime','exitTime','equityAfter','slipBps'
  ]);
}

// 🔹 Lưu TRADE khi đóng hoàn toàn vị thế
function addTrade(trade) {
  appendCSV('paper_trades.csv', trade, [
    'posId','symbol','timeframe','side',
    'entryTime','entryPlan','entryExec',
    'exitTime','exitAvg','qty','pnl','hits',
    'equityAfter','slipBps'
  ]);
}

// 🔹 Equity point: chỉ ghi khi có trade đóng hoàn toàn
function addEquityPoint(point) {
  appendCSV('paper_equity.csv', point, ['time','equity']);
}

function addPositionSnapshot(pos) {
  appendCSV('paper_positions.csv', pos, ['time','symbol','side','qty','entryExec','stop','tp1','tp2']);
}

module.exports = { addEntry, addExit, addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
