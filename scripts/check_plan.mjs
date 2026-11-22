// Headless check of the operator plan: event 1 with no memory, save its record, plan event 2.
// node scripts/check_plan.mjs [--sample]   (--sample writes public/data/plan.sample.json)
import fs from 'node:fs';
import { buildNet, planEvent, runEvent } from '../src/plan.js';

const data = JSON.parse(fs.readFileSync(new URL('../public/data/foxborough.json', import.meta.url)));
const net = buildNet(data);
const c = { cars: 14000, trains: 3000, contraflow: false, budget: 50000 };

const row = (p) => `${p.kind.padEnd(5)} avg ${String(p.result.avgInCarMin).padStart(5)} min | last out ${p.result.lastOutMin} min | saved ${p.result.carMinSaved.toLocaleString('en-US').padStart(7)} car-min | spent $${p.result.spent.toLocaleString('en-US')} | ${p.result.perThousand.toLocaleString('en-US')} per $1,000`;
const lots = (p) => Object.entries(p.cards).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, k]) => `${n} ${k}`).join(', ');

let t0 = Date.now();
const p1 = planEvent(net, c, []);
console.log(`event 1 plan (${Date.now() - t0} ms, ${p1.cars} cars, no cards: avg ${p1.base.avgInCarMin} min, last out ${p1.base.lastOutMin} min)`);
console.log(' ', row(p1.today)); console.log(' ', row(p1.ours)); console.log('  ours cards:', lots(p1.ours)); p1.why.forEach((w) => console.log('  why:', w));

const real1 = runEvent(net, c, p1.ours, '2026-11-23-g1');
const today1 = runEvent(net, c, p1.today, 'today-check');
console.log('event 1 played (real take rates):');
console.log('  today', JSON.stringify({ avg: today1.record.result.avgInCarMin, per1k: today1.record.result.perThousand, spent: today1.record.result.spent }));
console.log('  ours ', JSON.stringify({ avg: real1.record.result.avgInCarMin, per1k: real1.record.result.perThousand, spent: real1.record.result.spent }));

t0 = Date.now();
const p2 = planEvent(net, c, [real1.record]);
console.log(`event 2 plan with event 1's record (${Date.now() - t0} ms):`);
console.log(' ', row(p2.today)); console.log(' ', row(p2.ours)); console.log('  ours cards:', lots(p2.ours)); p2.why.forEach((w) => console.log('  why:', w));
const real2 = runEvent(net, c, p2.ours, '2026-11-23-g2');
console.log('event 2 played:', JSON.stringify({ avg: real2.record.result.avgInCarMin, per1k: real2.record.result.perThousand, spent: real2.record.result.spent }));

if (process.argv.includes('--sample')) {
  const strip = (p) => ({ kind: p.kind, budget: p.budget, cards: p.cards, result: p.result });
  const sample = { conditions: c, base: p2.base, today: strip(p2.today), ours: strip(p2.ours), why: p2.why, records: [real1.record] };
  fs.writeFileSync(new URL('../public/data/plan.sample.json', import.meta.url), JSON.stringify(sample, null, 2) + '\n');
  console.log('wrote public/data/plan.sample.json');
}
