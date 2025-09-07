// src/worker_strategy.js
require('dotenv').config();
const { schedule } = require('./scheduler');

const SID = (process.env.STRATEGY || 'default').toLowerCase();
console.log(`[worker] starting strategy=${SID}`);
schedule();
