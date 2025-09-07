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

function addTrade(trade) {
  appendCSV('paper_trades.csv', trade, [
    'symbol','timeframe','side',
    'entryTime','entryPlan','entryExec',
    'exitTime','exitAvg','qty','pnl','hits',
    'equityAfter','slipBps'
  ]);
}

function addEquityPoint(point) {
  appendCSV('paper_equity.csv', point, ['time','equity']);
}

function addPositionSnapshot(pos) {
  appendCSV('paper_positions.csv', pos, ['time','symbol','side','qty','entryExec','stop','tp1','tp2']);
}

module.exports = { addTrade, addEquityPoint, addPositionSnapshot, PAPER_DIR };
