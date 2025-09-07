const { MongoClient } = require('mongodb');
const { env, collFor, sanitizeSid, STRATEGY } = require('../config');

let clientPromise = null;

async function getClient(){
  if (!clientPromise){
    const client = new MongoClient(env.MONGO_URI, { ignoreUndefined: true });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb(){
  const client = await getClient();
  return client.db(env.MONGO_DB);
}

async function getColl(base, sid = STRATEGY){
  const db = await getDb();
  return db.collection(collFor(base, sanitizeSid(sid)));
}

async function ensureIndexes(){
  if (!env.MONGO_ENABLE) return;
  const db = await getDb();
  const sids = [STRATEGY]; // you can pre-create for more strategies if needed
  for (const sid of sids){
    await db.collection(collFor('entries', sid)).createIndexes([
      { key: { entryTs: -1 } }, { key: { symbol: 1 } }, { key: { side: 1 } }
    ]);
    await db.collection(collFor('exits', sid)).createIndexes([
      { key: { exitTs: -1 } }, { key: { symbol: 1 } }, { key: { label: 1 } }
    ]);
    await db.collection(collFor('trades', sid)).createIndexes([
      { key: { entryTs: -1 } }, { key: { exitTs: -1 } }, { key: { symbol: 1 } }
    ]);
    await db.collection(collFor('equity', sid)).createIndexes([
      { key: { time: -1 } }, { key: { timeTs: -1 } }
    ]);
    await db.collection(collFor('positions', sid)).createIndexes([
      { key: { snapshotTs: -1 } }, { key: { symbol: 1 } }
    ]);
    await db.collection(collFor('state', sid)).createIndexes([
      { key: { _id: 1 } }
    ]);
  }
}

module.exports = { getDb, getColl, ensureIndexes };
