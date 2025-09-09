const express = require('express');
require('dotenv').config();
const { initMongo } = require('./paper_db_mongo');
const paperOrdersRouter = require('./routes/paper_orders');
const equityRouter      = require('./routes/equity');
const equitySnapsRouter = require('./routes/equity_snapshots');

const app = express();
app.use(express.json());
try { const cors = require('cors'); app.use(cors()); } catch(e){}

app.use(paperOrdersRouter);
app.use(equityRouter);
app.use(equitySnapsRouter);

const PORT = Number(process.env.PORT || 3001);
initMongo().then(()=>{
  app.listen(PORT, ()=>console.log(`Paper API listening on :${PORT}`));
});
