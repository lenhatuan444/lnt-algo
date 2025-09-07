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

// 🔸 Lưu entry ngay khi mở lệnh paper
function addEntry(open) {
  appendCSV('paper_entries.csv', open, [
    'symbol','timeframe','side',
    'entryTime','entryPlan','entryExec','qty',
    'equityBefore','slipBps','reason'
  ]);
}

// Lưu trade khi đóng lệnh (TP/SL/BE)
function addTrade(trade) {
  appendCSV('paper_trades.csv', trade, [
    'symbol','timeframe','side',
    'entryTime','entryPlan','entryExec',
    'exitTime','exitAvg','qty','pnl','hits',
    'equityAfter','slipBps'
  ]);
}

// Ghi equity point (được gọi từ bot.js — chỉ khi có lệnh đóng)
function addEquityPoint(point) {
  appendCSV('paper_equity.csv', point, ['time','equity']);
}

function addPositionSnapshot(pos) {
  appendCSV('paper_positions.csv', pos, ['time','symbol','side','qty','entryExec','stop','tp1','tp2']);
}

module.exports = { addEntry, addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
