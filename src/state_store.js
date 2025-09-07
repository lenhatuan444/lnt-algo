const fs = require('fs');
const path = require('path');
const { env, STRATEGY, sanitizeSid, fileFor } = require('./config');
let mongo = null;

if (env.MONGO_ENABLE){
  try { mongo = require('./db/mongo'); } catch(e){ console.error('[mongo] state_store load err:', e.message); }
}

function stateFilePath(sid=STRATEGY){
  return path.join(process.cwd(), fileFor('state', sanitizeSid(sid)));
}

async function loadState(sid=STRATEGY){
  if (env.MONGO_ENABLE && mongo){
    try {
      const coll = await mongo.getColl('state', sid);
      const doc = await coll.findOne({ _id: 'singleton' });
      return (doc && doc.state) ? doc.state : {};
    } catch (e){
      console.error('[mongo] load err:', e.message);
    }
  }
  try {
    const p = stateFilePath(sid);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch(e){
    return {};
  }
}

async function saveState(state, sid=STRATEGY){
  if (env.MONGO_ENABLE && mongo){
    try {
      const coll = await mongo.getColl('state', sid);
      await coll.updateOne({ _id: 'singleton' }, { $set: { state } }, { upsert: true });
      return;
    } catch(e){
      console.error('[mongo] save err:', e.message);
    }
  }
  try {
    const p = stateFilePath(sid);
    fs.writeFileSync(p, JSON.stringify(state, null, 2));
  } catch(e){
    console.error('[file] save err:', e.message);
  }
}

module.exports = { loadState, saveState };
