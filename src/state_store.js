// src/state_store.js
const fs = require('fs');
const path = require('path');
const { env } = require('./config');

let mongo = null;
if (env.MONGO_ENABLE) {
  try { mongo = require('./db/mongo'); } catch (e) { console.error('[mongo] state_store load err:', e.message); }
}

const FILE_PATH = path.join(process.cwd(), 'bot_state.json');

function loadStateFromFile() {
  try {
    const txt = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(txt);
  } catch (_) {
    return {};
  }
}
function saveStateToFile(state) {
  try {
    fs.writeFileSync(FILE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[state] write file error:', e.message);
  }
}

async function loadState() {
  if (!(env.MONGO_ENABLE && mongo)) return loadStateFromFile();
  try {
    const db = await mongo.getDb();
    const coll = db.collection(env.MONGO_COLL_STATE);
    const doc = await coll.findOne({ _id: 'singleton' });
    return doc && doc.state ? doc.state : {};
  } catch (e) {
    console.error('[state] mongo load error, fallback file:', e.message);
    return loadStateFromFile();
  }
}

async function saveState(state) {
  if (!(env.MONGO_ENABLE && mongo)) return saveStateToFile(state);
  try {
    const db = await mongo.getDb();
    const coll = db.collection(env.MONGO_COLL_STATE);
    await coll.updateOne(
      { _id: 'singleton' },
      { $set: { state, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.error('[state] mongo save error, fallback file:', e.message);
    saveStateToFile(state);
  }
}

module.exports = { loadState, saveState };
