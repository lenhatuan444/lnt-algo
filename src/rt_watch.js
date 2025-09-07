const fs = require('fs');
const path = require('path');
const { sanitizeSid, fileFor, STRATEGY } = require('./config');

const memory = new Map(); // sid -> Set

function filePath(sid=STRATEGY){
  return path.join(process.cwd(), fileFor('rtwatch', sanitizeSid(sid)));
}

function load(sid=STRATEGY){
  sid = sanitizeSid(sid);
  if (memory.has(sid)) return memory.get(sid);
  try {
    const p = filePath(sid);
    if (fs.existsSync(p)){
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      const set = new Set(arr);
      memory.set(sid, set);
      return set;
    }
  } catch(_){}
  const set = new Set();
  memory.set(sid, set);
  return set;
}

function save(sid=STRATEGY){
  sid = sanitizeSid(sid);
  const p = filePath(sid);
  const set = load(sid);
  fs.writeFileSync(p, JSON.stringify([...set], null, 2));
}

function get(sid=STRATEGY){ return [...load(sid)]; }
function add(symbols=[], sid=STRATEGY){
  const set = load(sid);
  for (const s of (symbols||[])) if (s) set.add(s);
  save(sid);
  return get(sid);
}
function remove(symbols=[], sid=STRATEGY){
  const set = load(sid);
  for (const s of (symbols||[])) set.delete(s);
  save(sid);
  return get(sid);
}
function setAll(symbols=[], sid=STRATEGY){
  const set = load(sid);
  set.clear();
  for (const s of (symbols||[])) if (s) set.add(s);
  save(sid);
  return get(sid);
}

module.exports = { get, add, remove, setAll };
