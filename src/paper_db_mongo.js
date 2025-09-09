const { MongoClient, ObjectId } = require('mongodb');
const { ensureAccount, incEquity } = require('./equity_store_mongo');

let _client, _db, _coll;
const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://127.0.0.1:27017';
const MONGO_DB   = process.env.MONGO_DB   || 'trade_log';
const COLL_NAME  = process.env.MONGO_COLL_ORDERS || 'paper_orders';

async function initMongo(){
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI, { maxPoolSize: 8 });
  await _client.connect();
  _db = _client.db(MONGO_DB);
  _coll = _db.collection(COLL_NAME);
  await _coll.createIndex({ status: 1, symbol: 1 });
  await _coll.createIndex({ openedAt: -1 });
  await _coll.createIndex({ strategyId: 1, timeframe: 1, status: 1 });
  return _db;
}

function oid(id){ try{ return new ObjectId(id); } catch { return null; } }

async function createOrder(order){
  await initMongo();
  const now=Date.now();
  const doc = {
    status:'open', openedAt: order.openedAt||now, symbol: order.symbol, side: order.side, leverage: order.leverage,
    timeframe: order.timeframe||'4h', strategyId: order.strategyId||'macd_dualema_rvol', reason: order.reason||'',
    entryPrice:Number(order.entryPrice), stopPrice:Number(order.stopPrice), tpPrice:Number(order.tpPrice),
    qty:Number(order.qty), notional:Number(order.notional), margin:Number(order.margin), riskDollar:Number(order.riskDollar),
    equityAtOpen:Number(order.equityAtOpen || process.env.EQUITY || 10000),
    meta: order.meta || {},
  };
  const r = await _coll.insertOne(doc);
  return { id:r.insertedId.toString(), ...doc };
}

async function updateOrder(id, patch={}){
  await initMongo();
  const _id = oid(id); if (!_id) return null;
  const r = await _coll.findOneAndUpdate({ _id }, { $set: patch }, { returnDocument:'after' });
  return r.value ? { id:r.value._id.toString(), ...r.value } : null;
}

async function getOrder(id){
  await initMongo();
  const _id = oid(id); if (!_id) return null;
  const d = await _coll.findOne({ _id });
  return d ? { id:d._id.toString(), ...d } : null;
}

async function listOpenOrders(filter={}){
  await initMongo();
  const cur = _coll.find({ status:'open', ...filter });
  const out = []; for await (const d of cur) out.push({ id:d._id.toString(), ...d });
  return out;
}

async function listOrders({ status='open', timeframe, strategyId, symbol, limit=100, skip=0 }={}){
  await initMongo();
  const q = {};
  if (status==='open') q.status='open';
  else if (status==='closed') q.status = { $in: ['closed_tp','closed_sl','closed_manual'] };
  if (timeframe)  q.timeframe=timeframe;
  if (strategyId) q.strategyId=strategyId;
  if (symbol)     q.symbol=symbol;
  limit=Math.max(1, Math.min(1000, Number(limit)||100));
  skip =Math.max(0, Number(skip)||0);
  const sort=(status==='open')?{openedAt:-1}:{closedAt:-1,openedAt:-1};
  const cur = _coll.find(q).sort(sort).skip(skip).limit(limit);
  const out=[]; for await (const d of cur) out.push({ id:d._id.toString(), ...d });
  return out;
}

async function closeOrder(id, exitPrice, mode='tp'){
  await initMongo();
  const _id = oid(id); if (!_id) return null;
  const o = await _coll.findOne({ _id }); if (!o) return null;

  const qty=Number(o.qty||0), entry=Number(o.entryPrice||0), side=String(o.side||'long');
  const fill=Number(exitPrice||0), margin=Number(o.margin||0)||1e-9, equity0=Number(o.equityAtOpen||0)||1e-9;
  const notional = Number(o.notional || entry*qty) || 1e-9;
  let pnlUsd = (side==='long') ? (fill-entry)*qty : (entry-fill)*qty;

  const equityBeforeClose = equity0;
  const equityAfterClose  = equityBeforeClose + pnlUsd;
  const equityChangeUsd   = pnlUsd;
  const equityChangePct   = (equityAfterClose - equityBeforeClose)/equityBeforeClose*100;

  const UPDATE_ACCT = String(process.env.UPDATE_ACCOUNT_EQUITY_ON_CLOSE || '1')==='1';
  let accountEquityBefore=null, accountEquityAfter=null, accountEquityChangePct=null;
  if (UPDATE_ACCT){
    await ensureAccount(process.env.ACCOUNT_ID || 'default', Number(process.env.EQUITY_INITIAL || process.env.EQUITY || 10000));
    const snap = await incEquity(process.env.ACCOUNT_ID || 'default', pnlUsd, { reason:`order_close_${mode}`, refOrderId:id });
    accountEquityBefore = snap.equityBefore; accountEquityAfter = snap.equityAfter;
    accountEquityChangePct = (accountEquityAfter - accountEquityBefore)/Math.max(1e-9, accountEquityBefore)*100;
  }

  const closed = {
    status: mode==='tp' ? 'closed_tp' : (mode==='sl' ? 'closed_sl' : 'closed_manual'),
    exitPrice: fill, closedAt: Date.now(), pnlUsd,
    pnlPctOnMargin: (pnlUsd/margin)*100, pnlPctOnEquity:(pnlUsd/equity0)*100, pnlPctOnNotional:(pnlUsd/notional)*100,
    equityBeforeClose, equityAfterClose, equityChangeUsd, equityChangePct,
    accountEquityBefore, accountEquityAfter, accountEquityChangeUsd:pnlUsd, accountEquityChangePct,
  };
  const r = await _coll.findOneAndUpdate({ _id }, { $set: closed }, { returnDocument:'after' });
  return r.value ? { id:r.value._id.toString(), ...r.value } : null;
}

module.exports = { initMongo, createOrder, updateOrder, closeOrder, listOpenOrders, listOrders, getOrder };
