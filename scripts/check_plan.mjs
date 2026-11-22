// Headless check of the exit planner: every option for one night, and the lot schedule.
// node scripts/check_plan.mjs [cars] [--zipper=0.25] [--staff=3] [--no-cf] [--no-delayed]
import fs from 'node:fs';
import { buildNet, planExit } from '../src/plan.js';

const data = JSON.parse(fs.readFileSync(new URL('../public/data/foxborough.json', import.meta.url)));
const net = buildNet(data);
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? +a.split('=')[1] : d; };
const c = { cars: +(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 14000), trains: 3000, zipper: arg('zipper', 0.25), budget: 50000, releaseMin: 75,
  contraflow: !process.argv.includes('--no-cf'), staff: arg('staff', 3), delayed: !process.argv.includes('--no-delayed') };
const f = (x) => Math.round(x).toLocaleString('en-US');
const t0 = Date.now();
const p = planExit(net, c);
console.log(`${p.cars} cars, zipper ${c.zipper}, ${Date.now() - t0} ms`);
for (const o of p.options) {
  const m = o.m;
  console.log(`  ${o.name.padEnd(52)} to highway ${String(m.avgHomeMin).padStart(5)} min | over an hour in car ${f(m.over60).padStart(5)} | last car ${m.lastOutMin} min | in car ${m.avgInCarMin} | cards $${f(m.spent)}${m.held ? ` | delayed fans in car ${m.heldInCarMin} min` : ''}`);
}
console.log('  staffed gates:', p.staffed.join(', '));
console.log('  delayed lots:', p.plan.lots.join(', '));
if (p.releaseTest) console.log('  open at:', p.releaseTest.rows.map((r) => `${r.min}: over-hour ${f(r.over60)}, home ${r.avgHomeMin}`).join(' | '), '-> pick', p.releaseTest.pick);
const none = Object.fromEntries(p.options[0].schedule.map((s) => [s.lot, s]));
console.log('  lot schedule (plan vs nothing), slowest first:');
p.plan.schedule.filter((s) => s.cars >= 50).sort((a, b) => none[b.lot].emptyMin - none[a.lot].emptyMin).slice(0, 10)
  .forEach((s) => console.log(`    ${s.lot.padEnd(16)} ${String(s.cars).padStart(5)} cars, gate ${s.gate}/min${s.staffed ? ' STAFFED' : ''}${s.delayed ? ' DELAYED' : ''}: first out ${s.firstOutMin}, empty at ${s.emptyMin} min (nothing extra: ${none[s.lot].emptyMin})`));
