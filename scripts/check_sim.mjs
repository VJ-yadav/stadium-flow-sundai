// Headless runs of the traffic model: node scripts/check_sim.mjs
import fs from 'node:fs';
import { buildNet, Season, Game } from '../src/sim.js';
const data = JSON.parse(fs.readFileSync(new URL('../public/data/fenway.json', import.meta.url)));
const net = buildNet(data);
const supply = net.lots.reduce((a, l) => a + l.capEst, 0);
console.log(`route network ${(net.links.reduce((a, l) => a + l.len, 0) / 1000).toFixed(1)} km, ${net.links.length} links, ${net.cells.length} cells, ${net.lots.length} lots and garages, ${supply} fan spaces, ${net.gateways.length} ways out`);

const base = { cars: 4500, shareWest: 0.4, shareNorth: 0.35, background: 0.3, police: false, remoteShift: 0, stayLate: false, trust: 0.6 };
const scenarios = [
  ['4,500 cars, a normal night', {}],
  ['Same, police wave traffic out', { police: true }],
  ['Same, 20% of close-in cars moved to the Prudential and Clarendon garages', { remoteShift: 0.2 }],
  ['Same, stay-late offer in the close garages', { stayLate: true }],
  ['Same, heavy city traffic (55% of the road taken)', { background: 0.55 }],
  ['3,000 cars (more fans on the T)', { cars: 3000 }],
  ['6,000 cars (sellout, few on the T)', { cars: 6000 }],
];
const row = (s) => `${s.avgInCarMin.toFixed(0)} min in car (${s.avgToStreetMin.toFixed(0)} to reach the street), final-out rush clear at ${s.rushClearMin.toFixed(0)} min, last car ${s.lastOutMin.toFixed(0)} min${s.finished ? '' : ' (NOT finished)'}, slowest: ${s.worst.map((w) => `${w.name} ${w.avgInCarMin.toFixed(0)}`).join('; ')}`;
for (const [name, o] of scenarios) {
  const opts = { ...base, ...o }, t0 = Date.now();
  const s = new Season(net, opts);
  const d = s.departures(s.habit);
  const g = new Game(net, { lot: s.lot, path: s.path, dep: d.dep, opt: d.opt }, opts);
  const r = g.runToEnd();
  const kinds = Object.entries(r.byKind).map(([k, v]) => `${k} ${v.cars} cars ${v.avgInCarMin.toFixed(0)}/${v.avgToStreetMin.toFixed(0)}`).join(', ');
  console.log(`${name}: ${s.N} cars. ${row(r)}. By type (in car/to street): ${kinds}. ${Date.now() - t0} ms`);
}
{
  // which way out is used, and how the lots filled, on the normal night
  const s = new Season(net, base), use = {};
  for (let i = 0; i < s.N; i++) use[net.gateways[s.gw[i]].id] = (use[net.gateways[s.gw[i]].id] || 0) + 1;
  console.log('ways out:', Object.entries(use).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log('fill:', net.lots.map((l, i) => `${l.name.slice(0, 18)} ${s.perLot[i]}/${l.capEst}`).join(' | '));
}
{
  // a season: do fans who remember their own waits do better than fans who never change?
  const t0 = Date.now(), s = new Season(net, base), line = [];
  for (let g = 0; g < 8; g++) { const { rec } = s.play({}); line.push(`${rec.mem.avgInCarMin.toFixed(1)}/${rec.habit.avgInCarMin.toFixed(1)} (${(rec.changed * 100).toFixed(0)}% changed)`); }
  console.log(`season of 8, remember/habit min in car by game: ${line.join(' ')} | ${((Date.now() - t0) / 8).toFixed(0)} ms/game`);
}
