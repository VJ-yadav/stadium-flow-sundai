// The operator's plan: which whole lots become delayed-release lots tonight.
//
// How the program works (Gillette "Be Paid to Park", 2025 season): parking in a delayed lot is
// free, fans reserve a spot before the game, the lot is locked 30 min after kickoff, it opens
// 75 min after the game and every car in it gets a $50 Visa card. So a delayed lot holds every
// car in it, and the cost is cars x $50. There is no take rate to guess.
//
// planEvent()  before a game: no delayed lots, today's lot and the recommended (or the operator's
//              own) set of delayed lots, each measured the way the operator sees the night:
//              minutes Route 1 is jammed, cars stuck at the worst moment, blocked gates, idling.
// runEvent()   plays the night for one plan and returns the record the operator saves. The next
//              planEvent() reads the gate speeds it counted.
//
// trueExit() stands in for the real world: the plan never reads it. It learns each lot's gate
// speed from saved records. Every rate is an estimate until the venue gives gate counts.
import { buildCells, nearestCell, Game, rng, OPTIONS, JAM } from './sim.js';

export const CARD_USD = 50;
export const HOLD_MIN = 75;            // today's rule: delayed lots open 75 min after the game
export const PRIOR_EXIT = 15;          // cars a minute per lot exit, assumed before any record
export const MIN_LOT_CARS = 50;        // smaller lots are not worth a gate crew
export const TODAY_LOTS = ['Lot 55'];  // stands in for the stadium's Lots 45 and 55B
const RIDERS_PER_CAR = 5000 / 1200;    // Foxborough police: 5,000 riders is about 1,200 cars
const HABIT = [0.55, 0.2, 0.1, 0.05, 0.04, 0.03, 0.03]; // share leaving at each OPTIONS time
const JAM_CELLS = 10;                  // Route 1 counts as jammed with 400 m or more at walking pace

export function buildNet(data) {
  const { cells, total } = buildCells(data.route1);
  const lots = data.lots.map((l, i) => ({ ...l, name: l.name || `Unnamed lot ${i + 1}`, cell: nearestCell(cells, l.c[0], l.c[1]) }));
  return { cells, total, lots };
}

function hash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; }
// Hidden "real" cars a minute a lot's gates let out: 6 to 24, fixed per lot.
export function trueExit(name) { return Math.round(6 + 18 * hash('exit:' + name)); }
// The same network with each lot's exit rate set.
export function withExits(net, rates) { return { ...net, lots: net.lots.map((l, i) => ({ ...l, rate: rates[i] })) }; }
export const realNet = (net) => withExits(net, net.lots.map((l) => trueExit(l.name)));

export function carsAfterTrains(c) { return Math.max(0, c.cars - Math.round((c.trains || 0) / RIDERS_PER_CAR)); }

// The crowd for one event: lot, direction and usual leaving time of every car.
export function crowd(net, c) {
  const N = carsAfterTrains(c), R = rng(20261123), lots = net.lots;
  const caps = lots.map((l) => l.capEst), totalCap = caps.reduce((a, b) => a + b, 0);
  const lot = new Int16Array(N), dir = new Uint8Array(N), base = new Float32Array(N), walk = new Float32Array(N);
  let i = 0;
  for (let l = 0; l < lots.length && i < N; l++) for (let k = Math.round(N * caps[l] / totalCap); k > 0 && i < N; k--) lot[i++] = l;
  const share = c.shareNorth ?? 0.6;
  for (let k = 0; k < N; k++) {
    dir[k] = R() < share ? 0 : 1;
    let u = R(), o = 0; while (o < HABIT.length - 1 && u > HABIT[o]) { u -= HABIT[o]; o++; }
    walk[k] = 3 + R() * 10; base[k] = (OPTIONS[o] + walk[k]) * 60;
  }
  const sizes = new Int32Array(lots.length);
  for (let k = 0; k < N; k++) sizes[lot[k]]++;
  return { N, lot, dir, base, walk, sizes };
}

// c.zipper is optional: how lots and Route 1 share a full merge (see ZIPPER in sim.js).
const gameOpts = (c) => ({ lanesNorth: c.lanesNorth ?? 2, lanesSouth: c.lanesSouth ?? 2, contraflow: !!c.contraflow, ...(c.zipper != null && { zipper: +c.zipper }) });

// Leaving times when the lots in `delayed` (a Set of lot indexes) open at openMin.
function departures(cr, delayed, openMin) {
  const dep = Float32Array.from(cr.base), held = new Uint8Array(cr.N);
  for (let k = 0; k < cr.N; k++) if (delayed.has(cr.lot[k])) { held[k] = 1; dep[k] = Math.max(dep[k], (openMin + cr.walk[k]) * 60); }
  return { dep, held };
}

// Plays one night and measures it the way the operator sees it, minute by minute.
//   jamMin          minutes Route 1 has 400 m or more at walking pace (either direction)
//   peakStuck       cars stuck at the worst moment: waiting in a lot, or on a packed stretch
//   blockedGateMin  lot-minutes a gate had cars waiting but Route 1 outside was full
//   idleH           hours spent in a car with the engine on (lot queue + Route 1), all cars
//   avgHomeMin      whistle to leaving the area, average (Route 1's capacity sets this)
export function measure(net, cr, c, delayed = new Set(), openMin = HOLD_MIN, full = true) {
  const { dep, held } = departures(cr, delayed, openMin);
  const g = new Game(net, { lot: cr.lot, dir: cr.dir, dep }, gameOpts(c));
  let jamMin = 0, peakStuck = 0, peakAt = 0, blockedGateMin = 0, done = false;
  if (full) {
    while (!done && g.t < 6 * 3600) {
      for (let s = 0; s < 20 && !done; s++) done = g.step();       // one minute
      let stuck = 0, jammed = false;
      for (const q of g.lotQ) stuck += q.length;
      for (let d = 0; d < 2; d++) {
        const cap = JAM * g.lanes[d]; let packed = 0;
        for (const list of g.cell[d]) if (list.length >= cap) { stuck += list.length; packed++; }
        if (packed >= JAM_CELLS) jammed = true;
      }
      if (jammed) jamMin++;
      if (stuck > peakStuck) { peakStuck = stuck; peakAt = Math.round(g.t / 60); }
      net.lots.forEach((l, i) => { const q = g.lotQ[i]; if (q.length && g.cell[cr.dir[q[0]]][l.cell].length >= JAM * g.lanes[cr.dir[q[0]]]) blockedGateMin++; });
    }
  } else g.runToEnd();
  let inCar = 0, home = 0, last = 0, nHeld = 0, heldWait = 0;
  const cleared = new Float32Array(net.lots.length);
  for (let k = 0; k < cr.N; k++) {
    const o = g.state[k] === 3 ? g.out[k] : g.t;
    inCar += o - dep[k]; home += o; if (o > last) last = o;
    if (o > cleared[cr.lot[k]]) cleared[cr.lot[k]] = o;
    if (held[k]) { nHeld++; heldWait += dep[k] - cr.base[k]; }
  }
  const n = cr.N || 1;
  return {
    game: g, dep, held, cleared,
    m: {
      lots: delayed.size, held: nHeld, spent: nHeld * CARD_USD, openMin,
      jamMin, peakStuck, peakAt, blockedGateMin,
      idleH: Math.round(inCar / 3600), avgInCarMin: +(inCar / n / 60).toFixed(1),
      avgHomeMin: +(home / n / 60).toFixed(1), lastOutMin: Math.round(last / 60),
      heldWaitMin: nHeld ? Math.round(heldWait / nHeld / 60) : 0,
    },
  };
}

// Each lot's worth as a delayed lot: idling minutes saved for everyone, per car held there,
// if that lot alone were delayed. Cached per night and gate speeds.
const valueCache = new Map();
export function lotValues(net, cr, c, openMin, onProgress) {
  const key = JSON.stringify([cr.N, c.shareNorth ?? 0.6, gameOpts(c), openMin, net.lots.map((l) => l.rate)]);
  if (valueCache.has(key)) return valueCache.get(key);
  const base = measure(net, cr, c, new Set(), openMin, false).m;
  const values = net.lots.map((l, i) => {
    onProgress?.(i + 1, net.lots.length);
    if (cr.sizes[i] < MIN_LOT_CARS) return 0;
    const r = measure(net, cr, c, new Set([i]), openMin, false).m;
    return (base.idleH - r.idleH) * 60 / cr.sizes[i];
  });
  valueCache.set(key, values);
  return values;
}

// What the operator believes about each lot's gates, from saved records (newest first).
export function beliefs(net, records = []) {
  return net.lots.map((l) => {
    const exits = []; let exitFrom = null;
    for (const r of records) { const e = r.result?.exitPerMin?.[l.name]; if (e > 0) { exits.push(e); exitFrom ??= r.id; } }
    return { exit: exits.length ? exits.reduce((a, b) => a + b, 0) / exits.length : PRIOR_EXIT, exitFrom };
  });
}

// What the operator wants less of, each as a share of the night with no delayed lots, weighted
// equally: minutes Route 1 is jammed, gate-minutes blocked, engine-idling hours. Shares, so no
// one number swamps the others whatever the merge rule (with a full zipper merge the jam
// barely moves, but blocked gates and idling still do).
const share = (x, b) => x / Math.max(1, b);
const score = (m, base) => share(m.jamMin, base.jamMin) + share(m.blockedGateMin, base.blockedGateMin) + share(m.idleH, base.idleH);

// Lots chosen one at a time: each step adds the lot that cuts the score most per dollar, tried
// together with the lots already chosen (lots interact: two lots on the same stretch of
// Route 1 help less than two on different stretches). Stops when the budget is spent or no lot
// helps. Cached per night, gate speeds, budget and opening time.
const recCache = new Map();
function recommend(net, cr, c, openMin, base, onProgress) {
  const key = JSON.stringify([cr.N, c.shareNorth ?? 0.6, gameOpts(c), openMin, c.budget, net.lots.map((l) => l.rate)]);
  if (recCache.has(key)) return new Set(recCache.get(key));
  const cand = net.lots.map((l, i) => i).filter((i) => cr.sizes[i] >= MIN_LOT_CARS);
  const set = new Set(); let left = c.budget, cur = score(base, base), evals = 0;
  const guess = cand.length * 8;
  for (;;) {
    let best = null;
    for (const i of cand) {
      const cost = cr.sizes[i] * CARD_USD;
      if (set.has(i) || cost > left) continue;
      const s = new Set(set); s.add(i);
      const sc = score(measure(net, cr, c, s, openMin).m, base), gain = (cur - sc) / cost;
      if (sc < cur && (!best || gain > best.gain)) best = { i, sc, gain };
      onProgress?.(Math.min(++evals, guess), guess);
    }
    if (!best) break;
    set.add(best.i); left -= cr.sizes[best.i] * CARD_USD; cur = best.sc;
  }
  recCache.set(key, [...set]);
  return set;
}
const better = (a, b, base) => score(a, base) < score(b, base);

function vsBase(m, base) {
  const idleSavedH = base.idleH - m.idleH;
  return { ...m, idleSavedH, jamCutMin: base.jamMin - m.jamMin, peakCut: base.peakStuck - m.peakStuck, blockedCut: base.blockedGateMin - m.blockedGateMin,
    hPerThousand: m.spent ? +(idleSavedH / (m.spent / 1000)).toFixed(1) : 0 };
}
const names = (net, set) => [...set].map((i) => net.lots[i].name);
const indexes = (net, list) => new Set(list.map((n) => net.lots.findIndex((l) => l.name === n)).filter((i) => i >= 0));

// Before a game. picked: the operator's own list of lot names, or null for the recommendation.
export function planEvent(net0, c, records = [], onProgress, picked = null) {
  const bel = beliefs(net0, records);
  const net = withExits(net0, bel.map((b) => b.exit));
  const cr = crowd(net, c), openMin = c.releaseMin || HOLD_MIN;
  const values = lotValues(net, cr, c, openMin, (i, n) => onProgress?.(i, n * 6));
  const base = measure(net, cr, c).m;
  const mk = (kind, set, open) => ({ kind, lots: names(net, set), releaseMin: open, budget: c.budget, result: vsBase(measure(net, cr, c, set, open).m, base) });
  const today = mk('today', indexes(net, TODAY_LOTS), HOLD_MIN);
  let rec = recommend(net, cr, c, openMin, base, (i, n) => onProgress?.(n / 5 + i, n + n / 5)), fallback = false;
  let ours = mk('ours', picked ? indexes(net, picked) : rec, openMin);
  if (!picked && better(today.result, ours.result, base)) { rec = indexes(net, TODAY_LOTS); ours = mk('ours', rec, openMin); fallback = true; }
  ours.own = !!picked;
  const releaseTest = testRelease(net, cr, c, base, indexes(net, ours.lots));
  const whyLines = why(net0, records, bel, rec, values);
  if (fallback) whyLines.unshift("For this game no set of lots beat today's lot, so the plan keeps today's lot.");
  return {
    conditions: c, cars: cr.N, base, today, ours, recommended: names(net, rec), releaseTest, why: whyLines,
    values: net.lots.map((l, i) => ({ lot: l.name, i, cars: cr.sizes[i], cost: cr.sizes[i] * CARD_USD, value: +values[i].toFixed(1) })).sort((a, b) => b.value - a.value),
    beliefs: bel.map((b, i) => ({ lot: net.lots[i].name, exit: +b.exit.toFixed(1), exitFrom: b.exitFrom })),
  };
}

// When should the delayed lots open? Too early and they drive into the jam; too late and the
// fans wait for nothing. Advice: the earliest time that gets 90% of the best idling saved.
export const RELEASE_OPTIONS = [45, 60, 75, 90, 105];
function testRelease(net, cr, c, base, set) {
  if (!set.size) return { rows: [], pick: HOLD_MIN };
  const rows = RELEASE_OPTIONS.map((min) => { const m = measure(net, cr, c, set, min).m; return { min, idleSavedH: base.idleH - m.idleH, jamMin: m.jamMin, heldWaitMin: m.heldWaitMin }; });
  const best = Math.max(...rows.map((r) => r.idleSavedH));
  return { rows, pick: rows.find((r) => r.idleSavedH >= 0.9 * best)?.min ?? HOLD_MIN };
}

// Plays the night for a plan with the real gate speeds and returns the record to save.
export function runEvent(net0, c, plan, id) {
  const net = realNet(net0), cr = crowd(net, c);
  const set = indexes(net, plan.lots || []);
  const base = measure(net, cr, c).m;
  const run = measure(net, cr, c, set, plan.releaseMin);
  const clearedMin = {};
  net.lots.forEach((l, i) => { if (cr.sizes[i]) clearedMin[l.name] = Math.round(run.cleared[i] / 60); });
  return {
    record: { id, venue: 'gillette', conditions: c, plan: { kind: plan.kind, lots: plan.lots || [], releaseMin: plan.releaseMin, budget: plan.budget },
      result: { ...vsBase(run.m, base), clearedMin, exitPerMin: gateCounts(net, cr, run.game) } },
    dep: run.dep, held: run.held,
  };
}

// What a gate counter would show: each lot's cars a minute in its 5 busiest minutes.
// Only cars that had to queue at the gate count (otherwise a quiet gate looks slow), and a lot
// needs at least 100 queued cars to give a reading; smaller lots keep the assumed speed.
const MIN_QUEUED = 100;
function gateCounts(net, cr, game) {
  const per = net.lots.map(() => new Map()), queued = new Int32Array(net.lots.length), out = {}, dep = game.cars.dep;
  for (let k = 0; k < cr.N; k++) {
    if (game.state[k] < 2 || game.enter[k] - dep[k] < 60) continue;
    const l = cr.lot[k], m = Math.floor(game.enter[k] / 60), p = per[l];
    p.set(m, (p.get(m) || 0) + 1); queued[l]++;
  }
  per.forEach((p, l) => {
    if (queued[l] < MIN_QUEUED) return;
    const top = [...p.values()].sort((a, b) => b - a).slice(0, 5);
    out[net.lots[l].name] = +(top.reduce((a, b) => a + b, 0) / top.length).toFixed(1);
  });
  return out;
}

// Plain lines saying what memory changed in this plan, each naming its record.
// Compares tonight's recommendation with the lots used in the last saved game.
function why(net0, records, bel, rec, values) {
  if (!records.length) return [`No past games yet. Every lot's gate is assumed to let out ${PRIOR_EXIT} cars a minute. Save tonight's game and the next plan uses the real counts.`];
  const last = records[0], lastLots = new Set(last.plan?.lots || []), lines = [];
  const counted = Object.keys(last.result?.exitPerMin || {}).length;
  lines.push(`Using gate counts from ${records.length} saved game${records.length === 1 ? '' : 's'} (${counted} lots counted in ${last.id}).`);
  const changed = net0.lots.map((l, i) => i).filter((i) => rec.has(i) !== lastLots.has(net0.lots[i].name));
  for (const i of changed.slice(0, 4)) {
    const b = bel[i], n = net0.lots[i].name;
    const gate = b.exitFrom ? `its gate let out about ${Math.round(b.exit)} cars a minute in ${b.exitFrom} (we had assumed ${PRIOR_EXIT})` : 'no gate count yet';
    lines.push(`${n}: ${gate}. ${rec.has(i) ? 'Now a delayed lot' : 'No longer a delayed lot'} (about ${Math.round(values[i])} idling minutes saved per car held).`);
  }
  if (changed.length === 0) lines.push(`Same delayed lots as ${last.id}: the counts confirmed them.`);
  return lines;
}
