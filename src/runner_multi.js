// src/runner_multi.js
require('dotenv').config();
const { spawn } = require('child_process');

const strategies = (process.env.STRATEGIES || process.env.STRATEGY || 'default')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const children = [];

function spawnWorker(strategy) {
  const child = spawn('node', ['src/worker_strategy.js'], {
    env: { ...process.env, STRATEGY: strategy },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => process.stdout.write(`[${strategy}][worker] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${strategy}][worker:err] ${d}`));
  children.push(child);
}

function spawnWatcher(strategy) {
  const code = 'require("./src/realtime_paper").startRealtimePaperWatcher()';
  const child = spawn('node', ['-e', code], {
    env: { ...process.env, STRATEGY: strategy },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => process.stdout.write(`[${strategy}][rt] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[${strategy}][rt:err] ${d}`));
  children.push(child);
}

// 1) Start a worker (scheduler) per strategy
strategies.forEach(spawnWorker);

// 2) Optionally start RT watcher(s)
if (String(process.env.PAPER_REALTIME) === '1') {
  const mode = (process.env.RT_WATCH_MODE || 'active-only').toLowerCase();
  strategies.forEach(spawnWatcher);
  console.log(`[runner] RT watchers started for ${strategies.length} strategies (mode=${mode}).`);
} else {
  console.log('[runner] PAPER_REALTIME != 1 → RT watchers not started.');
}

// Graceful shutdown
function shutdown(sig) {
  console.log(`[runner] ${sig} received → shutting down children...`);
  children.forEach(c => { try { c.kill(sig); } catch (_) {} });
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
