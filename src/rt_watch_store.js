// src/rt_watch_store.js
// Shared in-memory control for realtime watcher across the process.
// Modes:
//  - auto   : watch only active paper positions
//  - manual : watch only the manual list below
//  - mix    : union of active + manual

let _symbols = new Set();
let _mode = (process.env.RT_WATCH_MODE || 'auto').toLowerCase(); // auto|manual|mix
let _version = 0;
let _updatedAt = Date.now();

function _norm(arr) {
  if (Array.isArray(arr)) return arr.map(s => String(s).trim()).filter(Boolean);
  if (typeof arr === 'string') return arr.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  return [];
}

function setSymbols(list) {
  _symbols = new Set(_norm(list));
  _version++; _updatedAt = Date.now();
}
function addSymbols(list) {
  for (const s of _norm(list)) _symbols.add(s);
  _version++; _updatedAt = Date.now();
}
function removeSymbols(list) {
  for (const s of _norm(list)) _symbols.delete(s);
  _version++; _updatedAt = Date.now();
}
function clearSymbols() {
  _symbols.clear();
  _version++; _updatedAt = Date.now();
}
function getSymbols() { return Array.from(_symbols); }

function setMode(m) {
  const v = String(m || '').toLowerCase();
  if (!['auto','manual','mix'].includes(v)) throw new Error('Invalid mode. Use auto|manual|mix');
  if (v !== _mode) { _mode = v; _version++; _updatedAt = Date.now(); }
}
function getMode() { return _mode; }

function getVersion() { return _version; }
function getUpdatedAt() { return _updatedAt; }

module.exports = {
  setSymbols, addSymbols, removeSymbols, clearSymbols, getSymbols,
  setMode, getMode, getVersion, getUpdatedAt
};
