// src/index.js
require('dotenv').config();

const { schedule } = require('./scheduler');
const { env } = require('./config');

// Start API server
require('./api_server');

// Start 4h scheduler
schedule();

// Optional: Real-time paper watcher (polling)
if (String(env.PAPER_REALTIME || '0') === '1') {
  const { startRealtimePaperWatcher } = require('./realtime_paper');
  startRealtimePaperWatcher().catch(err => {
    console.error('[rt] watcher failed:', err);
  });
}
