const express = require('express');
const router = express.Router();
const { listSnapshots, ensureAccount } = require('../equity_store_mongo');
router.get('/api/paper/equity/snapshots', async (req, res) => {
  try {
    const accountId = (req.query.accountId || process.env.ACCOUNT_ID || 'default').toString();
    const start  = req.query.start, end = req.query.end;
    const limit  = req.query.limit ? Number(req.query.limit) : 500;
    const skip   = req.query.skip  ? Number(req.query.skip)  : 0;
    const sort   = (req.query.sort || 'asc').toString();
    const compact = String(req.query.compact || '0') === '1';
    await ensureAccount(accountId);
    const data = await listSnapshots({ accountId, start, end, limit, skip, sort });
    if (compact) return res.json({ ok: true, accountId, count: data.length, series: data.map(d=>[d.at, d.equityAfter]) });
    return res.json({ ok: true, accountId, count: data.length, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});
module.exports = router;
