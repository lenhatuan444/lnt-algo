// Start API + Scheduler + Realtime watcher in one process
const { schedule } = require('./scheduler');
const { startRealtimePaperWatcher } = require('./realtime_paper');
require('./api_server'); // starts server

console.log('[index] starting scheduler...');
schedule();

console.log('[index] starting realtime watcher (if enabled)...');
startRealtimePaperWatcher();
