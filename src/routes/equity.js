const express = require('express');
const router = express.Router();
const { ensureAccount, getEquity } = require('../equity_store_mongo');
router.get('/api/paper/equity', async (req, res) => {
  try {
    const accountId = (req.query.accountId || process.env.ACCOUNT_ID || 'default').toString();
    await ensureAccount(accountId);
    const eq = await getEquity(accountId);
    res.json({ ok: true, accountId, equity: eq?.equity ?? null, updatedAt: eq?.updatedAt ?? null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message || String(e) }); }
});
module.exports = router;
