const { MongoClient } = require('mongodb');
let _client, _db, _accounts, _snaps;

const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://127.0.0.1:27017';
const MONGO_DB   = process.env.MONGO_DB   || 'trade_log';
const COLL_ACCOUNTS = process.env.MONGO_COLL_ACCOUNTS || 'paper_accounts';
const COLL_SNAPS    = process.env.MONGO_COLL_EQUITY_SNAPS || 'equity_snapshots';

async function _init(){
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI, { maxPoolSize: 8 });
  await _client.connect();
  _db = _client.db(MONGO_DB);
  _accounts = _db.collection(COLL_ACCOUNTS);
  _snaps    = _db.collection(COLL_SNAPS);
  await _accounts.createIndex({ accountId: 1 }, { unique: true });
  await _snaps.createIndex({ accountId: 1, at: -1 });
  return _db;
}

async function ensureAccount(accountId='default', initial=Number(process.env.EQUITY_INITIAL||process.env.EQUITY||10000)){
  await _init();
  const now=Date.now();
  await _accounts.updateOne(
    { accountId },
    { $setOnInsert: { accountId, equity:Number(initial)||0, createdAt:now }, $set:{ updatedAt:now } },
    { upsert:true }
  );
  const doc = await _accounts.findOne({ accountId });
  return { accountId: doc.accountId, equity:Number(doc.equity||0) };
}

async function getEquity(accountId='default'){
  await _init();
  const doc = await _accounts.findOne({ accountId });
  if (!doc) return null;
  return { accountId: doc.accountId, equity:Number(doc.equity||0), updatedAt: doc.updatedAt };
}

async function incEquity(accountId='default', deltaUsd=0, meta={}){
  await _init();
  const now=Date.now();
  const afterDoc = await _accounts.findOneAndUpdate(
    { accountId },
    { $inc:{ equity:Number(deltaUsd)||0 }, $set:{ updatedAt:now } },
    { upsert:true, returnDocument:'after' }
  );
  const equityAfter  = Number(afterDoc.value?.equity || 0);
  const equityBefore = equityAfter - Number(deltaUsd||0);
  const snap = { accountId, at:now, delta:Number(deltaUsd||0),
    equityBefore, equityAfter, reason: meta.reason||'order_close', refOrderId: meta.refOrderId||null, extra: meta.extra||null };
  await _snaps.insertOne(snap);
  return snap;
}

async function listSnapshots({ accountId='default', start, end, limit=500, skip=0, sort='asc' } = {}){
  await _init();
  const toMs = (v)=>{ if(v==null) return null; const n=Number(v); if(Number.isFinite(n)) return n; const p=Date.parse(String(v)); return Number.isFinite(p)?p:null; };
  const q = { accountId };
  const sMs = toMs(start), eMs = toMs(end);
  if (sMs!=null || eMs!=null){
    q.at = {};
    if (sMs!=null) q.at.$gte = sMs;
    if (eMs!=null) q.at.$lte = eMs;
  }
  limit = Math.max(1, Math.min(5000, Number(limit)||500));
  skip  = Math.max(0, Number(skip)||0);
  const sortObj = { at: (String(sort).toLowerCase()==='desc')? -1 : 1 };
  const cur = _snaps.find(q).sort(sortObj).skip(skip).limit(limit);
  const out=[];
  for await (const d of cur){
    out.push({ id:d._id.toString(), accountId:d.accountId, at:d.at,
      equityBefore:Number(d.equityBefore||0), equityAfter:Number(d.equityAfter||0), delta:Number(d.delta||0),
      reason:d.reason||'', refOrderId:d.refOrderId||null, extra:d.extra||null });
  }
  return out;
}

module.exports = { ensureAccount, getEquity, incEquity, listSnapshots };
