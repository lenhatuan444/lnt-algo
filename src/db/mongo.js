// src/db/mongo.js
const { MongoClient } = require('mongodb');
const { env } = require('../config');

let _client = null;
let _db = null;

async function getClient() {
  if (_client && _client.topology && _client.topology.isConnected()) return _client;
  _client = new MongoClient(env.MONGO_URI, { maxPoolSize: 10 });
  await _client.connect();
  return _client;
}

async function getDb() {
  if (_db) return _db;
  const client = await getClient();
  _db = client.db(env.MONGO_DB);
  return _db;
}

async function getColl(name) {
  const db = await getDb();
  return db.collection(name);
}

async function ensureIndexes() {
  if (!env.MONGO_ENABLE) return;
  const db = await getDb();
  await db.collection(env.MONGO_COLL_ENTRIES).createIndexes([
    { key: { symbol: 1 } }, { key: { side: 1 } },
    { key: { entryTs: -1 } }, { key: { entryTime: -1 } },
  ]);
  await db.collection(env.MONGO_COLL_EXITS).createIndexes([
    { key: { symbol: 1 } }, { key: { side: 1 } },
    { key: { label: 1 } }, { key: { posId: 1 } },
    { key: { exitTs: -1 } }, { key: { exitTime: -1 } },
  ]);
  await db.collection(env.MONGO_COLL_TRADES).createIndexes([
    { key: { symbol: 1 } }, { key: { side: 1 } },
    { key: { entryTs: -1 } }, { key: { exitTs: -1 } },
  ]);
  await db.collection(env.MONGO_COLL_EQUITY).createIndexes([
    { key: { time: -1 } }
  ]);
  await db.collection(env.MONGO_COLL_POSITIONS).createIndexes([
    { key: { symbol: 1 } }, { key: { side: 1 } }, { key: { openedAt: -1 } }
  ]);
}

module.exports = { getClient, getDb, getColl, ensureIndexes };
