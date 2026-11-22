// Runs the exit planner off the main thread so the 3D view keeps moving while it tests options.
import { buildNet, planExit } from './plan.js';

let net = null;

onmessage = (e) => {
  const m = e.data;
  if (m.data) net = buildNet(m.data);
  if (m.type !== 'plan') return;
  const plan = planExit(net, m.c, (i, n) => { if (i % 4 === 0) postMessage({ type: 'progress', i, n }); }, m.picked || null);
  postMessage({ type: 'plan', plan });
};
