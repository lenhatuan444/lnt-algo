// src/run_all.js
// Run scanner + TP watcher + SL watcher + API server together (no 'concurrently' needed)
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('node:path');

const FRAME_MS = Number(process.env.TIMEFRAME_MS || 4*60*60*1000); // 4h
const AFTER_MIN = Number(process.env.SCAN_AFTER_CLOSE_MIN || 1);   // scan start +1m after bar close
const POLL_MS = Number(process.env.SCAN_POLL_MS || 15000);

const RUN_SCAN = String(process.env.RUN_SCAN ?? '1') === '1';
const RUN_TP   = String(process.env.RUN_TP   ?? '1') === '1';
const RUN_SL   = String(process.env.RUN_SL   ?? '1') === '1';
const RUN_API  = String(process.env.RUN_API  ?? '1') === '1';

const SCAN_LOOP      = String(process.env.SCAN_LOOP ?? '1') === '1'; // schedule by 4H
const SCAN_IMMEDIATE = String(process.env.SCAN_IMMEDIATE ?? '1') === '1'; // run once on start

const BIN_NODE = process.execPath;
const SRC = (...p) => path.resolve(__dirname, ...p);

function spawnNode(name, scriptPath, args = [], { autorestart = true } = {}) {
  console.log(`[orchestrator] start ${name}: node ${path.relative(process.cwd(), scriptPath)} ${args.join(' ')}`);
  let child = spawn(BIN_NODE, [scriptPath, ...args], { stdio: 'inherit' });

  child.on('exit', (code, signal) => {
    console.log(`[orchestrator] ${name} exited: code=${code} signal=${signal}`);
    if (autorestart) {
      const delay = 3000;
      console.log(`[orchestrator] restart ${name} in ${delay/1000}s`);
      setTimeout(() => {
        child = spawnNode(name, scriptPath, args, { autorestart });
      }, delay);
    }
  });

  return child;
}

function floorToFrame(ts, frame) { return Math.floor(ts / frame) * frame; }

async function runScannerOnce() {
  return new Promise((resolve) => {
    const p = spawn(BIN_NODE, [SRC('scan_macd_4h.js')], { stdio: 'inherit' });
    p.on('exit', () => resolve());
  });
}

async function scheduleScannerLoop() {
  console.log(`[orchestrator] scanner loop: frame=${FRAME_MS/3600000}h, start +${AFTER_MIN}m after close`);
  let lastStart = null;
  const tick = async () => {
    const now = Date.now();
    const startTs = floorToFrame(now, FRAME_MS) + AFTER_MIN * 60 * 1000;
    if (now >= startTs && startTs !== lastStart) {
      console.log(`[orchestrator] >> run scanner at ${new Date(now).toISOString()}`);
      await runScannerOnce();
      lastStart = startTs;
    }
  };
  await tick();
  setInterval(tick, POLL_MS);
}

(async () => {
  const children = [];

  if (RUN_TP) children.push(spawnNode('TPwatch', SRC('rt_tp_closer.js'), [], { autorestart: true }));
  if (RUN_SL) children.push(spawnNode('SLwatch', SRC('rt_sl_postclose.js'), [], { autorestart: true }));
  if (RUN_API) children.push(spawnNode('API', SRC('paper_orders_server.js'), [], { autorestart: true }));

  if (RUN_SCAN) {
    if (SCAN_IMMEDIATE) await runScannerOnce();
    if (SCAN_LOOP) await scheduleScannerLoop();
  }

  const shutdown = () => {
    console.log('[orchestrator] shutting down...');
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error('[orchestrator] fatal', e);
  process.exit(1);
});
