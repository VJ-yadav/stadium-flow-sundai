// Runs the plan off the main thread so the 3D view keeps moving while it thinks (4 to 10 s).
import { buildNet, planEvent, runEvent } from './plan.js';

let net = null;
const NONE = { kind: 'none', budget: 0, releaseMin: 75, alloc: [], cards: {} };

onmessage = (e) => {
  const m = e.data;
  if (m.data) net = buildNet(m.data);
  if (m.type !== 'plan') return;
  const plan = planEvent(net, m.c, m.records, (i, n) => { if (i % 8 === 0) postMessage({ type: 'progress', i, n }); });
  // Play each plan in the "real world" so the 3D view can replay it and the operator can save it.
  const runs = {};
  for (const p of [NONE, plan.today, plan.ours]) {
    const r = runEvent(net, m.c, p, m.id), g = r.replay();
    runs[p.kind] = { record: r.record, dep: g.game.cars.dep, held: g.held };
  }
  postMessage({ type: 'plan', plan, runs });
};
