// Runs the plan off the main thread so the 3D view keeps moving while it thinks.
import { buildNet, planEvent, runEvent } from './plan.js';

let net = null;
const NONE = { kind: 'none', lots: [], releaseMin: 75, budget: 0 };

onmessage = (e) => {
  const m = e.data;
  if (m.data) net = buildNet(m.data);
  if (m.type !== 'plan') return;
  const plan = planEvent(net, m.c, m.records, (i, n) => { if (i % 4 === 0) postMessage({ type: 'progress', i, n }); }, m.picked || null);
  // Play each plan with the real gate speeds so the 3D view can replay it and the operator can save it.
  const runs = {};
  for (const p of [NONE, plan.today, plan.ours]) {
    const r = runEvent(net, m.c, p, m.id);
    runs[p.kind] = { record: r.record, dep: r.dep, held: r.held };
  }
  postMessage({ type: 'plan', plan, runs });
};
