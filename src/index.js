// src/start_all.js
require('dotenv').config();

// start the scheduler
const { schedule } = require('./scheduler');
schedule();

// start the API server (it calls app.listen on require)
require('./api_server');
