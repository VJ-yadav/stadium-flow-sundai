import fs from 'node:fs';
import { buildCells, nearestCell, Season, ZIPPER } from '../src/sim.js';
// node scripts/check_sim.mjs [--zipper=0]   0 gives Route 1 traffic the whole merge; default 1
const zip = process.argv.find((a) => a.startsWith('--zipper='));
const zipper = zip ? +zip.split('=')[1] : ZIPPER;
const data = JSON.parse(fs.readFileSync(new URL('../public/data/foxborough.json', import.meta.url)));
const { cells, total } = buildCells(data.route1);
const lots = data.lots.map((l) => ({ ...l, cell: nearestCell(cells, l.c[0], l.c[1]), delayed: l.name === 'Lot 55' }));
const net = { cells, lots };
console.log('route 1 km', (total / 1000).toFixed(2), 'cells', cells.length, 'zipper', zipper);
for (const [lanes, contra, cars] of [[2, false, 14000], [2, true, 14000], [1, false, 14000], [2, false, 8000]]) {
  const t0 = Date.now();
  const s = new Season(net, { cars, shareNorth: 0.6, trust: 0.6 });
  const line = [];
  for (let g = 0; g < 8; g++) { const { rec } = s.play({ lanesNorth: lanes, lanesSouth: 2, contraflow: contra, zipper }); line.push(`${rec.mem.avgInCarMin.toFixed(0)}/${rec.habit.avgInCarMin.toFixed(0)}`); }
  const r = s.games.at(-1);
  console.log(`lanesN ${lanes} contra ${contra} cars ${cars}: remember/habit min in car by game ${line.join(' ')} | lots empty ${r.habit.lastOutMin.toFixed(0)} vs ${r.mem.lastOutMin.toFixed(0)} min | ${((Date.now() - t0) / 8).toFixed(0)} ms/game`);
}
