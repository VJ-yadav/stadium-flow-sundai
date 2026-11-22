// The exit planner: before a game, the operator tries the options that change how fast fans get
// out, on a traffic model of the real Route 1, and sees the result of each one.
//
// Options (each can be on or off, and they combine):
//   contraflow    MassDOT turns one southbound lane northbound: one more lane toward I-95.
//   gate staff    extra attendants (or a second exit lane) at the gates that take longest to
//                 empty, so they let out STAFF_RATE cars a minute.
//   delayed lots  Gillette's "Be Paid to Park" (2025 season): parking is free, the lot opens
//                 75 min after the game and every car gets a $50 Visa card. The planner picks
//                 which whole lots, within the card budget.
//
// planExit() measures every option alone and all chosen options together, the same night, and
// returns what the 3D view needs to replay "nothing extra", "today" and "the plan".
//
// Every rate here is an estimate until the venue gives counts, including each lot's gate speed
// (gateSpeed(): 6 to 24 cars a minute, fixed per lot).
import { buildCells, nearestCell, Game, rng, OPTIONS, JAM } from './sim.js';

export const CARD_USD = 50;
export const HOLD_MIN = 75;            // today's rule: delayed lots open 75 min after the game
export const STAFF_RATE = 24;          // cars a minute from a staffed gate (estimate)
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
// Estimated cars a minute each lot's gates let out: 6 to 24, fixed per lot (no counts yet).
export function gateSpeed(name) { return Math.round(6 + 18 * hash('exit:' + name)); }
// The same network with each lot's exit rate set.
export function withExits(net, rates) { return { ...net, lots: net.lots.map((l, i) => ({ ...l, rate: rates[i] })) }; }
export const gateNet = (net, staffed = new Set()) => withExits(net, net.lots.map((l, i) => (staffed.has(i) ? Math.max(STAFF_RATE, gateSpeed(l.name)) : gateSpeed(l.name))));

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
export const gameOpts = (c) => ({ lanesNorth: c.lanesNorth ?? 2, lanesSouth: c.lanesSouth ?? 2, contraflow: !!c.contraflow, ...(c.zipper != null && { zipper: +c.zipper }) });

// Leaving times when the lots in `delayed` (a Set of lot indexes) open at openMin.
function departures(cr, delayed, openMin) {
  const dep = Float32Array.from(cr.base), held = new Uint8Array(cr.N);
  for (let k = 0; k < cr.N; k++) if (delayed.has(cr.lot[k])) { held[k] = 1; dep[k] = Math.max(dep[k], (openMin + cr.walk[k]) * 60); }
  return { dep, held };
}

// Plays one night and measures it the way the operator sees it.
//   avgHomeMin      whistle to the highway, average driver
//   over60          drivers who sit more than an hour in their car (lot queue + Route 1)
//   lastOutMin      when the last car reaches the highway
//   avgInCarMin     minutes in the car, average driver
//   heldInCarMin    for delayed-lot fans: minutes in the car after their lot opens
//   firstOut/cleared per lot: when its first and last car reached Route 1's end (seconds)
//   jamMin, blockedGateMin (full runs only): minutes Route 1 is jammed, lot-minutes a gate was blocked
export function measure(net, cr, c, delayed = new Set(), openMin = HOLD_MIN, full = true) {
  const { dep, held } = departures(cr, delayed, openMin);
  const g = new Game(net, { lot: cr.lot, dir: cr.dir, dep }, gameOpts(c));
  let jamMin = 0, blockedGateMin = 0, done = false;
  if (full) {
    while (!done && g.t < 6 * 3600) {
      for (let s = 0; s < 20 && !done; s++) done = g.step();       // one minute
      let jammed = false;
      for (let d = 0; d < 2; d++) {
        const cap = JAM * g.lanes[d]; let packed = 0;
        for (const list of g.cell[d]) if (list.length >= cap) packed++;
        if (packed >= JAM_CELLS) jammed = true;
      }
      if (jammed) jamMin++;
      net.lots.forEach((l, i) => { const q = g.lotQ[i]; if (q.length && g.cell[cr.dir[q[0]]][l.cell].length >= JAM * g.lanes[cr.dir[q[0]]]) blockedGateMin++; });
    }
  } else g.runToEnd();
  let inCar = 0, home = 0, last = 0, nHeld = 0, heldIn = 0, over60 = 0;
  const L = net.lots.length, cleared = new Float32Array(L), firstOut = new Float32Array(L).fill(Infinity), emptyAt = new Float32Array(L);
  for (let k = 0; k < cr.N; k++) {
    const o = g.state[k] === 3 ? g.out[k] : g.t, t = o - dep[k], l = cr.lot[k];
    inCar += t; home += o; if (o > last) last = o; if (t > 3600) over60++;
    if (o > cleared[l]) cleared[l] = o;
    const e = g.enter[k] || o; if (e < firstOut[l]) firstOut[l] = e; if (e > emptyAt[l]) emptyAt[l] = e;
    if (held[k]) { nHeld++; heldIn += t; }
  }
  const n = cr.N || 1;
  return {
    game: g, dep, held, cleared, firstOut, emptyAt,
    m: {
      lots: delayed.size, held: nHeld, spent: nHeld * CARD_USD, openMin,
      avgHomeMin: +(home / n / 60).toFixed(1), over60, lastOutMin: Math.round(last / 60),
      avgInCarMin: +(inCar / n / 60).toFixed(1), heldInCarMin: nHeld ? Math.round(heldIn / nHeld / 60) : 0,
      idleH: Math.round(inCar / 3600), jamMin, blockedGateMin,
    },
  };
}

// Each lot's worth as a delayed lot (for ordering the list): minutes in the car saved for
// everyone, per car held there, if that lot alone were delayed.
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

// Delayed lots are scored on what they can change: drivers stuck over an hour, minutes in the
// car, and blocked gates, each as a share of the same night without them, weighted equally.
const share = (x, b) => x / Math.max(1, b);
const score = (m, base) => share(m.over60, base.over60) + share(m.idleH, base.idleH) + share(m.blockedGateMin, base.blockedGateMin);

// Lots chosen one at a time: each step adds the lot that helps most per dollar, tried together
// with the lots already chosen (two lots on the same stretch of Route 1 help less than two on
// different stretches). Stops when the budget is spent or no lot helps.
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

// The gates that take longest to empty: cars in the lot / cars a minute its gate lets out.
export function slowestGates(net, cr, n) {
  return new Set(net.lots.map((l, i) => i).filter((i) => cr.sizes[i] >= MIN_LOT_CARS)
    .sort((a, b) => cr.sizes[b] / gateSpeed(net.lots[b].name) - cr.sizes[a] / gateSpeed(net.lots[a].name)).slice(0, n));
}

const names = (net, set) => [...set].map((i) => net.lots[i].name);
const indexes = (net, list) => new Set(list.map((n) => net.lots.findIndex((l) => l.name === n)).filter((i) => i >= 0));

// Before a game. c: cars, trains, zipper, and the options chosen:
//   contraflow (bool), staff (number of slowest gates to staff, 0 = none),
//   delayed (bool), budget, releaseMin. picked: the operator's own delayed lots, or null.
export function planExit(net0, c, onProgress, picked = null) {
  const open = c.releaseMin || HOLD_MIN, nStaff = c.staff || 0;
  const plain = gateNet(net0), cr = crowd(plain, c);
  const staffed = slowestGates(plain, cr, nStaff), withStaff = gateNet(net0, staffed);
  const off = { ...c, contraflow: false };
  // Delayed lots are chosen for the night as the plan will run it (with its lane and its staff).
  const ctxNet = nStaff ? withStaff : plain, ctxC = { ...c, contraflow: !!c.contraflow };
  const values = lotValues(ctxNet, cr, ctxC, open, (i, n) => onProgress?.(i, n * 6));
  let delayed = new Set();
  if (c.delayed) delayed = picked ? indexes(plain, picked) : recommend(ctxNet, cr, ctxC, open, measure(ctxNet, cr, ctxC).m, (i, n) => onProgress?.(n / 5 + i, n + n / 5));
  const recommended = c.delayed && !picked ? names(plain, delayed) : (c.delayed ? names(plain, recommend(ctxNet, cr, ctxC, open, measure(ctxNet, cr, ctxC).m)) : []);

  const run = (key, name, { cf = false, staff = false, lots = new Set() }) => {
    const net = staff ? withStaff : plain, cc = cf ? { ...c, contraflow: true } : off;
    const r = measure(net, cr, cc, lots, open);
    return { key, name, contraflow: cf, staffed: staff ? names(plain, staffed) : [], lots: names(plain, lots), releaseMin: open, m: r.m,
      replay: { dep: r.dep, held: r.held, rates: Float32Array.from(net.lots, (l) => l.rate), contraflow: cf },
      schedule: net.lots.map((l, i) => ({ lot: l.name, cars: cr.sizes[i], gate: l.rate, staffed: staff && staffed.has(i), delayed: lots.has(i),
        firstOutMin: cr.sizes[i] && isFinite(r.firstOut[i]) ? Math.round(r.firstOut[i] / 60) : null, emptyMin: cr.sizes[i] ? Math.round(r.emptyAt[i] / 60) : null })) };
  };
  const options = [run('none', 'Nothing extra', {}), run('today', 'Today: Lot 55 delayed', { lots: indexes(plain, TODAY_LOTS) })];
  if (c.contraflow) options.push(run('contraflow', 'Contraflow lane', { cf: true }));
  if (nStaff) options.push(run('staff', `Extra staff at the ${nStaff} slowest gates`, { staff: true }));
  if (c.delayed) options.push(run('delayed', `${delayed.size} delayed lots`, { lots: delayed }));
  const chosen = [c.contraflow && 'contraflow', nStaff && `staff at ${nStaff} gates`, c.delayed && `${delayed.size} delayed lots`].filter(Boolean);
  const plan = run('plan', chosen.length ? `Plan: ${chosen.join(' + ')}` : 'Plan: nothing chosen', { cf: !!c.contraflow, staff: nStaff > 0, lots: delayed });
  plan.own = !!picked;
  options.push(plan);
  return {
    conditions: c, cars: cr.N, options, plan, recommended, staffed: names(plain, staffed),
    releaseTest: c.delayed ? testRelease(ctxNet, cr, ctxC, delayed) : null,
    values: plain.lots.map((l, i) => ({ lot: l.name, i, cars: cr.sizes[i], cost: cr.sizes[i] * CARD_USD, gate: gateSpeed(l.name), value: +values[i].toFixed(1) })).sort((a, b) => b.value - a.value),
  };
}

// When should the delayed lots open? Too early and they drive into the jam; too late and the
// fans wait for nothing. Advice: the earliest time within 2% of the fewest drivers over an hour.
export const RELEASE_OPTIONS = [45, 60, 75, 90, 105];
function testRelease(net, cr, c, set) {
  if (!set.size) return null;
  const rows = RELEASE_OPTIONS.map((min) => { const m = measure(net, cr, c, set, min, false).m; return { min, over60: m.over60, avgHomeMin: m.avgHomeMin, heldInCarMin: m.heldInCarMin }; });
  const best = Math.min(...rows.map((r) => r.over60));
  return { rows, pick: rows.find((r) => r.over60 <= best * 1.02)?.min ?? HOLD_MIN };
}
