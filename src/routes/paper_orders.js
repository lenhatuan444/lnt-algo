const express = require('express');
const router = express.Router();
const { initMongo, listOrders } = require('../paper_db_mongo');

router.get('/api/paper/orders', async (req, res) => {
  try {
    await initMongo();
    const status     = (req.query.status || 'open').toString();
    const timeframe  = req.query.timeframe ? req.query.timeframe.toString() : undefined;
    const strategyId = req.query.strategyId ? req.query.strategyId.toString() : undefined;
    const symbol     = req.query.symbol ? req.query.symbol.toString() : undefined;
    const limit      = req.query.limit ? Number(req.query.limit) : 100;
    const skip       = req.query.skip  ? Number(req.query.skip)  : 0;
    const data = await listOrders({ status, timeframe, strategyId, symbol, limit, skip });
    res.json({ ok: true, count: data.length, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});
module.exports = router;
