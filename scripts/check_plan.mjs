// Headless check of the operator plan: game 1 with no memory, save its record, plan game 2.
// node scripts/check_plan.mjs [cars] [cf]
import fs from 'node:fs';
import { buildNet, planEvent, runEvent } from '../src/plan.js';

const data = JSON.parse(fs.readFileSync(new URL('../public/data/foxborough.json', import.meta.url)));
const net = buildNet(data);
const c = { cars: +(process.argv[2] || 14000), trains: 3000, contraflow: process.argv[3] === 'cf', budget: 50000, releaseMin: 75 };
const zip = process.argv.find((a) => a.startsWith('--zipper='));
c.zipper = zip ? +zip.split('=')[1] : 0.25;   // default: mostly Route 1 first (see ZIPPER in sim.js)
const f = (x) => Math.round(x).toLocaleString('en-US');
const row = (name, m) => console.log(`  ${name.padEnd(8)} lots ${String(m.lots).padStart(2)} cars ${f(m.held).padStart(5)} $${f(m.spent).padStart(6)} | jammed ${m.jamMin} min | worst ${f(m.peakStuck)} stuck at ${m.peakAt} min | blocked gate-min ${m.blockedGateMin} | idling ${f(m.idleH)} h (saved ${f(m.idleSavedH ?? 0)}) | in car ${m.avgInCarMin} | home ${m.avgHomeMin}`);

let t0 = Date.now();
const p1 = planEvent(net, c, []);
console.log(`game 1 plan, ${p1.cars} cars, ${Date.now() - t0} ms`);
row('none', p1.base); row('today', p1.today.result); row('ours', p1.ours.result);
console.log('  delayed lots:', p1.ours.lots.join(', '));
console.log('  release test:', p1.releaseTest.rows.map((r) => `${r.min}: saves ${f(r.idleSavedH)} h, jam ${r.jamMin}, wait ${r.heldWaitMin}`).join(' | '), '-> pick', p1.releaseTest.pick);
p1.why.forEach((w) => console.log('  why:', w));

const g1 = runEvent(net, c, p1.ours, 'game-1');
console.log('game 1 played (real gates):'); row('ours', g1.record.result);
t0 = Date.now();
const p2 = planEvent(net, c, [g1.record]);
console.log(`game 2 plan with game 1's record, ${Date.now() - t0} ms`);
row('ours', p2.ours.result); console.log('  delayed lots:', p2.ours.lots.join(', '));
p2.why.forEach((w) => console.log('  why:', w));
row('played', runEvent(net, c, p2.ours, 'game-2').record.result);
const own = planEvent(net, c, [g1.record], null, ['Lot 55', 'Lot 42']);
console.log("operator's own pick (Lot 55 + Lot 42):"); row('own', own.ours.result);
