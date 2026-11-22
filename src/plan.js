// The operator's plan: which lots get the $50 delayed-release cards for a budget.
//
// planEvent()  before a game: today's fixed lot vs our ranked lots, with predicted results.
// runEvent()   plays the game for one plan with the real take rates and returns the record
//              the operator saves. The next planEvent() reads those records.
//
// trueTake() and trueExit() stand in for the real world: the plan never reads them. It learns
// them from saved records (cards taken, gate counts). Every rate is an estimate until the venue
// gives counts.
import { buildCells, nearestCell, Game, rng, OPTIONS } from './sim.js';

export const CARD_USD = 50;
export const HOLD_MIN = 75;            // card holders leave 75 min after the game
export const PRIOR_TAKE = 0.5;         // take rate assumed before any record exists
export const PROBE = 100;              // cars held per group to value it
export const PRIOR_EXIT = 15;          // cars a minute per lot exit, assumed before any record
export const TODAY_LOTS = ['Lot 55'];  // stands in for the stadium's Lots 45 and 55B
const RIDERS_PER_CAR = 5000 / 1200;    // Foxborough police: 5,000 riders is about 1,200 cars
const HABIT = [0.55, 0.2, 0.1, 0.05, 0.04, 0.03, 0.03]; // share leaving at each OPTIONS time

export function buildNet(data) {
  const { cells, total } = buildCells(data.route1);
  const lots = data.lots.map((l, i) => ({ ...l, name: l.name || `Unnamed lot ${i + 1}`, cell: nearestCell(cells, l.c[0], l.c[1]) }));
  return { cells, total, lots };
}

function hash(s) { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) / 4294967296; }
// Hidden "real" share of fans in a lot who take a card when offered: 20% to 80%, fixed per lot.
export function trueTake(name) { return 0.2 + 0.6 * hash(name); }
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
  const groups = Array.from({ length: lots.length * 2 }, () => []);
  for (let k = 0; k < N; k++) groups[lot[k] * 2 + dir[k]].push(k);
  return { N, lot, dir, base, walk, groups };
}

const gameOpts = (c) => ({ lanesNorth: c.lanesNorth ?? 2, lanesSouth: c.lanesSouth ?? 2, contraflow: !!c.contraflow });

// Plays one game. held: Uint8Array, 1 = this car took a card and leaves at +75 min.
export function play(net, cr, c, held, holdMin = HOLD_MIN) {
  const dep = Float32Array.from(cr.base);
  if (held) for (let k = 0; k < cr.N; k++) if (held[k]) dep[k] = Math.max(dep[k], (holdMin + cr.walk[k]) * 60);
  const game = new Game(net, { lot: cr.lot, dir: cr.dir, dep }, gameOpts(c));
  game.runToEnd();
  let total = 0, last = 0, home = 0, extra = 0;
  const cleared = new Float32Array(net.lots.length);
  for (let k = 0; k < cr.N; k++) {
    const o = game.state[k] === 3 ? game.out[k] : game.t;
    total += o - dep[k]; home += o; extra += dep[k] - cr.base[k]; if (o > last) last = o;
    if (o > cleared[cr.lot[k]]) cleared[cr.lot[k]] = o;
  }
  const n = cr.N || 1;
  // totalMin: minutes sitting in a car (lot queue + Route 1), the thing the plan reduces.
  // avgHomeMin: game end to leaving the map. extraWaitMin: extra minutes card holders stayed.
  return { game, dep, totalMin: total / 60, avgInCarMin: total / n / 60, avgHomeMin: home / n / 60, extraWaitMin: extra / 60, lastOutMin: last / 60, cleared };
}

// Car-minutes saved per held car, for each lot x direction group. Cached per conditions.
const valueCache = new Map();
export function groupValues(net, cr, c, onProgress) {
  const key = JSON.stringify([cr.N, c.shareNorth ?? 0.6, gameOpts(c), net.lots.map((l) => l.rate)]);
  if (valueCache.has(key)) return valueCache.get(key);
  const base = play(net, cr, c, null);
  const values = new Float32Array(cr.groups.length);
  cr.groups.forEach((m, g) => {
    if (!m.length) return;
    const held = new Uint8Array(cr.N), n = Math.min(PROBE, m.length);
    for (let j = 0; j < n; j++) held[m[j]] = 1;
    values[g] = (base.totalMin - play(net, cr, c, held).totalMin) / n;
    onProgress?.(g + 1, cr.groups.length);
  });
  const out = { base, values };
  valueCache.set(key, out);
  return out;
}

// What the operator believes about each lot, from saved records (newest first):
// the share of offered cards taken, and how many cars a minute its gates let out.
export function beliefs(net, records = []) {
  return net.lots.map((l) => {
    let off = 0, took = 0, from = null, exitFrom = null;
    const exits = [];
    for (const r of records) {
      const o = r.result?.offered?.[l.name] || 0;
      if (o > 0) { off += o; took += r.result.taken?.[l.name] || 0; from ??= r.id; }
      const e = r.result?.exitPerMin?.[l.name];
      if (e > 0) { exits.push(e); exitFrom ??= r.id; }
    }
    return {
      rate: off > 0 ? took / off : PRIOR_TAKE, from,
      exit: exits.length ? exits.reduce((a, b) => a + b, 0) / exits.length : PRIOR_EXIT, exitFrom,
    };
  });
}

// Cards per group. Each entry: { g, offered, cards } where cards is what we expect to pay out.
function allocate(cr, order, rates, budget) {
  let left = Math.floor(budget / CARD_USD);
  const alloc = [];
  for (const g of order) {
    if (left <= 0) break;
    const size = cr.groups[g].length, r = Math.max(0.01, rates[g >> 1]);
    if (!size) continue;
    const cards = Math.min(left, Math.floor(size * r));
    if (cards <= 0) continue;
    alloc.push({ g, offered: Math.min(size, Math.ceil(cards / r)), cards });
    left -= cards;
  }
  return alloc;
}

// Which cars hold back. take(lotIndex) gives the share who accept; cards cap the payout per group.
function holders(cr, alloc, take, seed) {
  const held = new Uint8Array(cr.N), R = rng(seed);
  const offered = {}, taken = {};
  for (const a of alloc) {
    const m = cr.groups[a.g], l = a.g >> 1;
    let t = 0;
    for (let j = 0; j < a.offered && t < a.cards; j++) if (R() < take(l)) { held[m[j]] = 1; t++; }
    offered[l] = (offered[l] || 0) + a.offered; taken[l] = (taken[l] || 0) + t;
  }
  return { held, offered, taken };
}

function byLot(net, obj) { const o = {}; for (const [l, v] of Object.entries(obj)) o[net.lots[l].name] = Math.round(v); return o; }

function result(net, base, run, h) {
  const takenTotal = Object.values(h.taken).reduce((a, b) => a + b, 0);
  const spent = takenTotal * CARD_USD, saved = base.totalMin - run.totalMin;
  return {
    avgInCarMin: +run.avgInCarMin.toFixed(1),
    avgHomeMin: +run.avgHomeMin.toFixed(1),
    lastOutMin: Math.round(run.lastOutMin),
    carMinSaved: Math.round(saved),
    spent,
    perThousand: spent ? Math.round(saved / (spent / 1000)) : 0,
    offered: byLot(net, h.offered),
    taken: byLot(net, h.taken),
  };
}

function todayAlloc(net, cr, budget, rates) {
  // Today: every car in the fixed lots is offered; cards are paid until the budget runs out.
  const gs = [];
  net.lots.forEach((l, i) => { if (TODAY_LOTS.includes(l.name)) gs.push(i * 2, i * 2 + 1); });
  let left = Math.floor(budget / CARD_USD);
  return gs.filter((g) => cr.groups[g].length).map((g) => {
    const size = cr.groups[g].length, cards = Math.min(left, size); left -= cards;
    return { g, offered: size, cards, rate: rates[g >> 1] };
  }).filter((a) => a.cards > 0);
}

function cardsByLot(net, alloc) {
  const o = {};
  for (const a of alloc) { const n = net.lots[a.g >> 1].name; o[n] = (o[n] || 0) + a.cards; }
  return o;
}

// Before a game: today's plan and ours, predicted with the take rates the operator believes.
// We pay only for cards taken, so groups rank by car-minutes saved per held car; the take rate
// sets how many cars must be offered to place the cards.
export function planEvent(net0, c, records = [], onProgress) {
  const bel = beliefs(net0, records), rates = bel.map((b) => b.rate);
  const net = withExits(net0, bel.map((b) => b.exit));
  const cr = crowd(net, c);
  const { base, values } = groupValues(net, cr, c, onProgress);
  const order = values.map((v, g) => g).filter((g) => values[g] > 0).sort((a, b) => values[b] - values[a]);
  const mk = (kind, alloc, releaseMin) => {
    const h = holders(cr, alloc, (l) => rates[l], 7);
    const run = play(net, cr, c, h.held, releaseMin);
    return { kind, budget: c.budget, releaseMin, alloc, cards: cardsByLot(net, alloc), result: result(net, base, run, h) };
  };
  const today = mk('today', todayAlloc(net, cr, c.budget, rates), HOLD_MIN);
  const ourAlloc = allocate(cr, order, rates, c.budget);
  const releaseTest = testRelease(net, cr, c, base, holders(cr, ourAlloc, (l) => rates[l], 7).held);
  // Same release time as today unless the operator picks one, so the lot choice is compared fairly.
  let ours = mk('ours', ourAlloc, c.releaseMin || HOLD_MIN);
  // Safety check: never recommend a plan the model expects to do worse than today's.
  if (ours.result.carMinSaved < today.result.carMinSaved) ours = { ...mk('ours', today.alloc, c.releaseMin || HOLD_MIN), fallback: true };
  const whyLines = why(net, records, bel, ours, values, records.length ? groupValues(withExits(net0, net0.lots.map(() => PRIOR_EXIT)), crowd(net0, c), c).values : values);
  if (ours.fallback) whyLines.unshift("For this game the model found no better split than today's lot, so it recommends today's lot. With an extra lane, the road copes better and spreading cards buys less.");
  return { conditions: c, cars: cr.N, base: { avgInCarMin: +base.avgInCarMin.toFixed(1), avgHomeMin: +base.avgHomeMin.toFixed(1), lastOutMin: Math.round(base.lastOutMin) }, today, ours, releaseTest, why: whyLines, values: groupList(net, cr, values), beliefs: bel.map((b, i) => ({ lot: net.lots[i].name, exit: +b.exit.toFixed(1), exitFrom: b.exitFrom, take: +b.rate.toFixed(2), takeFrom: b.from })) };
}

// When should the card lots open? Too early and card holders drive into the jam; too late and
// they wait in the stadium for nothing. Advice: the earliest time that gets 90% of the best saving.
export const RELEASE_OPTIONS = [30, 45, 60, 75, 90, 105];
function testRelease(net, cr, c, base, held) {
  const rows = RELEASE_OPTIONS.map((min) => {
    const r = play(net, cr, c, held, min);
    const nHeld = held.reduce((a, b) => a + b, 0) || 1;
    return { min, carMinSaved: Math.round(base.totalMin - r.totalMin), heldWaitMin: Math.round(r.extraWaitMin / nHeld), avgHomeMin: +r.avgHomeMin.toFixed(1) };
  });
  const best = Math.max(...rows.map((r) => r.carMinSaved));
  const pick = rows.find((r) => r.carMinSaved >= 0.9 * best)?.min ?? HOLD_MIN;
  return { rows, pick };
}

// Each lot x direction group with its value, for the UI (ranked, best first).
function groupList(net, cr, values) {
  return cr.groups.map((m, g) => ({ lot: net.lots[g >> 1].name, dir: g & 1 ? 'south' : 'north', cars: m.length, value: +values[g].toFixed(1) }))
    .filter((x) => x.cars).sort((a, b) => b.value - a.value);
}

// Plays the real game for a plan (real take rates) and returns the record to save.
export function runEvent(net0, c, plan, id) {
  const net = realNet(net0), cr = crowd(net, c);
  const { base } = groupValues(net, cr, c);
  const h = holders(cr, plan.alloc, (l) => trueTake(net.lots[l].name), 99);
  const run = play(net, cr, c, h.held, plan.releaseMin);
  const res = result(net, base, run, h);
  const clearedMin = {}, exitPerMin = gateCounts(net, cr, run.game);
  net.lots.forEach((l, i) => { if (cr.groups[i * 2].length + cr.groups[i * 2 + 1].length) clearedMin[l.name] = Math.round(run.cleared[i] / 60); });
  return {
    record: { id, venue: 'gillette', conditions: c, plan: { kind: plan.kind, budget: plan.budget, releaseMin: plan.releaseMin, cards: plan.cards }, result: { ...res, clearedMin, exitPerMin } },
    replay: () => ({ game: new Game(net, { lot: cr.lot, dir: cr.dir, dep: run.dep }, gameOpts(c)), held: h.held, crowd: cr, net }),
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
// valuesNow / valuesBefore: car-minutes saved per held car, by group, with and without the records.
function why(net, records, bel, ours, valuesNow, valuesBefore) {
  if (!records.length) return [`No past games yet. Every lot is assumed to let out ${PRIOR_EXIT} cars a minute and half the fans offered a card are assumed to take it.`];
  const last = records[0].plan?.cards || {}, now = ours.cards, lines = [];
  const names = new Set([...Object.keys(last), ...Object.keys(now)]);
  const diffs = [...names].map((n) => ({ n, d: (now[n] || 0) - (last[n] || 0) })).filter((x) => x.d !== 0).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const best = (vals, l) => Math.max(vals[l * 2], vals[l * 2 + 1]);
  for (const { n, d } of diffs.slice(0, 3)) {
    const l = net.lots.findIndex((x) => x.name === n), b = bel[l];
    const gate = b.exitFrom ? `Last game its gates let out about ${Math.round(b.exit)} cars a minute (we had assumed ${PRIOR_EXIT}).` : 'No gate count for it yet.';
    const v0 = Math.round(best(valuesBefore, l)), v1 = Math.round(best(valuesNow, l));
    const worth = `Holding one car there now saves about ${v1} minutes of driving in total, ${v1 > v0 ? 'up' : 'down'} from ${v0}.`;
    lines.push(`${n}: ${gate} ${worth} So ${d > 0 ? Math.abs(d) + ' more cards' : Math.abs(d) + ' fewer cards'} ($${(Math.abs(d) * CARD_USD).toLocaleString('en-US')}).`);
  }
  return lines.length ? lines : ['Same plan as last game: the new counts did not change which lots are best.'];
}
