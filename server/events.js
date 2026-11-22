// Event records: validate, save, list. localmem first, a local JSON file as the fallback.
//
// localmem keeps facts, not documents, and has no "list everything" call, so each event is:
//   1. one memory (write) whose content is the record as JSON, and
//   2. one index fact on the subject "<venue> events" pointing at that memory's event_id.
// Listing = recall the index subject, then get each memory and parse it.
// Every record is also written to the local file, so a GET still works with localmem down.
// The localmem key is read from process.env by the SDK and is never logged or returned.

import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_BYTES = 50 * 1024;
export const LOCALMEM_TIMEOUT_MS = 3000;

const FILE = process.env.EVENTS_FILE
  || (process.env.VERCEL ? '/tmp/stadium-flow-events.json' : path.resolve('server/data/events.json'));

// ---------- validation ----------
export class BadRequest extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function only(obj, keys, where) {
  if (!isObj(obj)) throw new BadRequest(`${where} must be an object`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new BadRequest(`unknown field ${where}.${k}`);
}
function num(v, where, { required = true } = {}) {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new BadRequest(`${where} must be a number >= 0`);
  return v;
}
function str(v, where, re, { required = true } = {}) {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !re.test(v)) throw new BadRequest(`${where} is not valid`);
  return v;
}
function lotMap(v, where) {
  if (!isObj(v)) throw new BadRequest(`${where} must be an object of lot name to number`);
  const keys = Object.keys(v);
  if (keys.length > 100) throw new BadRequest(`${where} has too many lots`);
  const out = {};
  for (const k of keys) {
    if (!/^[\w .'#&()-]{1,40}$/.test(k)) throw new BadRequest(`${where} has an invalid lot name`);
    out[k] = num(v[k], `${where}.${k}`);
  }
  return out;
}

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const VENUE_RE = /^[a-z0-9-]{1,32}$/;

/** Returns a clean copy of the record with only the known fields, or throws BadRequest. */
export function validateRecord(body) {
  only(body, ['id', 'venue', 'conditions', 'plan', 'result'], 'record');
  const { conditions: c, plan: p, result: r } = body;
  only(c, ['cars', 'trains', 'contraflow', 'weather'], 'conditions');
  only(p, ['kind', 'budget', 'cards'], 'plan');
  only(r, ['taken', 'clearedMin', 'avgInCarMin', 'lastOutMin'], 'result');
  if (typeof c.contraflow !== 'boolean') throw new BadRequest('conditions.contraflow must be true or false');
  if (p.kind !== 'today' && p.kind !== 'ours') throw new BadRequest("plan.kind must be 'today' or 'ours'");
  const rec = {
    id: str(body.id, 'id', ID_RE, { required: false }),
    venue: str(body.venue ?? 'gillette', 'venue', VENUE_RE),
    conditions: {
      cars: num(c.cars, 'conditions.cars'),
      trains: num(c.trains, 'conditions.trains'),
      contraflow: c.contraflow,
      weather: str(c.weather, 'conditions.weather', /^[\w -]{1,20}$/, { required: false }),
    },
    plan: { kind: p.kind, budget: num(p.budget, 'plan.budget'), cards: lotMap(p.cards, 'plan.cards') },
    result: {
      taken: lotMap(r.taken, 'result.taken'),
      clearedMin: lotMap(r.clearedMin, 'result.clearedMin'),
      avgInCarMin: num(r.avgInCarMin, 'result.avgInCarMin'),
      lastOutMin: num(r.lastOutMin, 'result.lastOutMin'),
    },
  };
  if (rec.conditions.weather === undefined) delete rec.conditions.weather;
  return rec;
}

// ---------- local file ----------
async function readFile() {
  try { return JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { return []; }
}
async function writeFile(records) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(records, null, 1));
  await fs.rename(tmp, FILE);
}
async function fileSave(rec) {
  const all = (await readFile()).filter((r) => !(r.id === rec.id && r.venue === rec.venue));
  all.push(rec);
  await writeFile(all);
}

// ---------- localmem ----------
let lmPromise = null;
function localmemConfigured() {
  return Boolean(process.env.LOCALMEM_PROJECT && process.env.LOCALMEM_KEY_ID && process.env.LOCALMEM_KEY_SECRET);
}
async function lm() {
  if (!lmPromise) {
    lmPromise = import('@localmem/memory').then(({ Memory }) => new Memory({ timeoutMs: LOCALMEM_TIMEOUT_MS, maxRetries: 0 }))
      .catch((e) => { lmPromise = null; throw e; });
  }
  return lmPromise;
}
const tenants = new Map();
async function tenantFor(mem, venue) {
  if (!tenants.has(venue)) {
    // One localmem customer per venue; the same ref again answers the same customer.
    const p = mem.customers.create(`venue-${venue}`).then((c) => c.tenant).catch((e) => { tenants.delete(venue); throw e; });
    tenants.set(venue, p);
  }
  return tenants.get(venue);
}
const subject = (venue) => `${venue} events`;

function withTimeout(promise, ms = LOCALMEM_TIMEOUT_MS) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('localmem timed out')), ms); })])
    .finally(() => clearTimeout(t));
}

async function localmemSave(rec) {
  const mem = await lm(), tenant = await tenantFor(mem, rec.venue);
  const w = await mem.write(tenant, {
    content: JSON.stringify(rec),
    tags: { kind: 'event-record', venue: rec.venue },
    as_of: rec.savedAt,
    idempotency_key: `event-${rec.venue}-${rec.id}-${rec.savedAt}`,
  });
  if (!w?.event_id) throw new Error('localmem write returned no event_id');
  await mem.facts(tenant, {
    facts: [{ subject: subject(rec.venue), predicate: 'has event record', object: `${rec.id} ${w.event_id}`, ref: rec.id }],
    tags: { kind: 'event-index', venue: rec.venue },
    idempotency_key: `index-${rec.venue}-${rec.id}-${w.event_id}`,
  });
  return w.event_id;
}

async function localmemList(venue) {
  const mem = await lm(), tenant = await tenantFor(mem, venue);
  const { facts = [] } = await mem.recall(tenant, { entity: subject(venue), limit: 1000 });
  const ids = [...new Set(facts.filter((f) => !f.retired_at && !f.retraction).map((f) => String(f.object).split(' ').at(-1)))];
  const got = await Promise.all(ids.map((event_id) => mem.get(tenant, { event_id }).catch(() => null)));
  const out = [];
  for (const g of got) {
    if (!g?.found || typeof g.content !== 'string') continue;
    try { out.push(JSON.parse(g.content)); } catch { /* not one of ours */ }
  }
  return out;
}

// ---------- public ----------
function newestFirst(records) {
  return records.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}
function nextId(existing, venue) {
  const day = new Date().toISOString().slice(0, 10);
  const n = existing.filter((r) => r.venue === venue && String(r.id).startsWith(day)).length + 1;
  return `${day}-g${n}`;
}

/** Saves a validated record. Returns { id, memory: 'localmem' | 'offline' }. */
export async function saveRecord(clean) {
  const rec = { ...clean, savedAt: new Date().toISOString() };
  if (!rec.id) rec.id = nextId(await readFile(), rec.venue);
  await fileSave(rec);
  if (!localmemConfigured()) return { id: rec.id, memory: 'offline', reason: 'localmem not configured' };
  try {
    await withTimeout(localmemSave(rec));
    return { id: rec.id, memory: 'localmem' };
  } catch (e) {
    return { id: rec.id, memory: 'offline', reason: reasonOf(e) };
  }
}

/** Past records for a venue, newest first. Returns { records, memory }. */
export async function listRecords(venue = 'gillette') {
  str(venue, 'venue', VENUE_RE);
  const local = (await readFile()).filter((r) => r.venue === venue);
  if (!localmemConfigured()) return { records: newestFirst(local), memory: 'offline', reason: 'localmem not configured' };
  try {
    const remote = await withTimeout(localmemList(venue));
    // Union by id: anything saved while localmem was down is still shown.
    const byId = new Map(local.map((r) => [r.id, r]));
    for (const r of remote) if (r?.venue === venue && r.id) byId.set(r.id, r);
    return { records: newestFirst([...byId.values()]), memory: 'localmem' };
  } catch (e) {
    return { records: newestFirst(local), memory: 'offline', reason: reasonOf(e) };
  }
}

// A short reason for the response, never the error object (which could carry request details).
function reasonOf(e) {
  if (e?.message === 'localmem timed out') return 'localmem timed out';
  if (e?.error) return `localmem error: ${String(e.error).slice(0, 40)}`;
  return 'localmem unreachable';
}
