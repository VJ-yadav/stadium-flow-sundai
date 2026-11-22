import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin } from '3d-tiles-renderer/three/plugins';
import { Game, JAM, CELL_M } from './sim.js';
import { buildNet, crowd, realNet, TODAY_LOTS, CARD_USD } from './plan.js';
import { listEvents, saveEvent, clearEvents, exportEvents } from './memory.js';

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

const data = await (await fetch('/data/foxborough.json')).json();
const net = buildNet(data);
const { cells, lots } = net;
const TODAY = lots.map((l) => TODAY_LOTS.includes(l.name));

// ---------- scene ----------
const app = $('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
app.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.cssText = 'position:fixed;inset:0;pointer-events:none';
app.appendChild(labels.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fb3c4');
const camera = new THREE.PerspectiveCamera(45, 1, 1, 60000);
camera.position.set(-1350, 1000, 1250);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-250, 0, -250);
controls.maxPolarAngle = Math.PI * 0.44;   // never tilt to or below the horizon
controls.screenSpacePanning = false;        // pan along the ground, not up and down
controls.minDistance = 80; controls.maxDistance = 6000;
controls.enableDamping = true;
// The target stays on the ground near Foxborough and the camera stays above whatever is under it
// (the Google ground is not at y = 0, so heights come from the tiles: groundY and a sample under the camera).
let underCam = null, sinceUnder = 0;
function keepAboveGround(dt) {
  const t = controls.target, g = groundY;
  t.x = THREE.MathUtils.clamp(t.x, -3000, 3000); t.z = THREE.MathUtils.clamp(t.z, -4500, 3000);
  const dy = g - t.y; t.y = g; camera.position.y += dy;
  if (tiles && (sinceUnder += dt) > 0.25) { sinceUnder = 0; underCam = sample(camera.position.x, camera.position.z); }
  const floor = Math.max(g, underCam ?? g) + 30;
  if (camera.position.y < floor) camera.position.y = floor;
}
scene.add(new THREE.HemisphereLight('#ffffff', '#4a5560', 1.4));
const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(-1000, 2000, 800); scene.add(sun);

const osm = new THREE.Group(); scene.add(osm);        // shown only without Google tiles
const overlay = new THREE.Group(); scene.add(overlay); // lots, Route 1, columns: always shown

function shapeOf(pts) { const s = new THREE.Shape(); pts.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z))); return s; }
function flat(pts, color, y, opacity = 1) {
  const g = new THREE.ShapeGeometry(shapeOf(pts)); g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
  m.position.y = y; return m;
}
function line(pts, color, y, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
function ribbon(pts, width, color, y, opacity = 1) {
  const pos = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L * width / 2, nz = dx / L * width / 2;
    pos.push(pts[i][0] + nx, y, pts[i][1] + nz, pts[i][0] - nx, y, pts[i][1] - nz);
  }
  const idx = []; for (let i = 0; i < pts.length - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
}
function label(text, x, y, z, cls = '') { const d = document.createElement('div'); d.className = 'lbl ' + cls; d.textContent = text; const o = new CSS2DObject(d); o.position.set(x, y, z); overlay.add(o); return o; }

// OSM model view
const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(9000, 11000), new THREE.MeshLambertMaterial({ color: '#7d9467' }));
groundMesh.rotation.x = -Math.PI / 2; groundMesh.position.z = -500; osm.add(groundMesh);
const roadColor = { primary: '#3a3f44', primary_link: '#3a3f44', secondary: '#555b60', tertiary: '#5d6368', residential: '#6c7176', unclassified: '#6c7176', service: '#80858a', tertiary_link: '#5d6368' };
const roadWidth = { primary: 16, primary_link: 8, secondary: 10, tertiary: 8, residential: 6, unclassified: 6, service: 4, tertiary_link: 6 };
for (const r of data.roads) osm.add(ribbon(r.p, roadWidth[r.c] || 4, roadColor[r.c] || '#777', r.c.startsWith('primary') ? 0.6 : 0.4));
for (const r of data.rail) osm.add(line(r.p, '#3b2f2a', 0.8));
const bMat = new THREE.MeshLambertMaterial({ color: '#d8d4cc' });
for (const b of data.buildings) { const g = new THREE.ExtrudeGeometry(shapeOf(b.p), { depth: b.h, bevelEnabled: false }); g.rotateX(-Math.PI / 2); osm.add(new THREE.Mesh(g, bMat)); }
if (data.stadium) {
  const g = new THREE.ExtrudeGeometry(shapeOf(data.stadium), { depth: 42, bevelEnabled: false }); g.rotateX(-Math.PI / 2);
  osm.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#c9ccd1' })));
}

// lot outlines and Route 1
const lotFill = lots.map((l, i) => { const m = flat(l.p, TODAY[i] ? '#7a5a1a' : '#2b3136', 0.5, KEY ? 0.3 : 1); overlay.add(m); overlay.add(line(l.p, '#f4f6f2', 1, 0.45)); return m; });
overlay.add(ribbon(data.route1, 20, '#f2a516', 1.2, 0.12));
const north = cells.at(-1), south = cells[0];
label('Gillette Stadium', 0, 80, 0, 'big');
label('Route 1 north · to I-95', north.x, 40, north.z, 'big');
label('Route 1 south · to I-495', south.x, 40, south.z, 'big');

// ---------- Google Photorealistic 3D Tiles ----------
let tiles = null;
if (KEY) {
  tiles = new TilesRenderer('https://tile.googleapis.com/v1/3dtiles/root.json');
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: KEY, autoRefreshToken: true }));
  const draco = new DRACOLoader().setDecoderPath('/draco/');
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TileCompressionPlugin());
  // Origin at the stadium, +Y up. Azimuth pi turns the frame so +X is east and +Z is south,
  // matching the OSM coordinates from scripts/build_data.py.
  tiles.registerPlugin(new ReorientationPlugin({ lat: data.origin.lat * THREE.MathUtils.DEG2RAD, lon: data.origin.lon * THREE.MathUtils.DEG2RAD, height: 0, azimuth: Math.PI, recenter: true }));
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.errorTarget = 12;
  scene.add(tiles.group);
  osm.visible = false;
  tiles.addEventListener('load-error', (e) => {
    osm.visible = true; tiles.group.visible = false;
    $('mode').textContent = 'Google tiles failed to load, so this is the OpenStreetMap model.';
    console.warn(e);
  });
  $('mode').textContent = 'Real 3D Gillette (Google) with OpenStreetMap lots and Route 1.';
} else {
  $('mode').textContent = 'OpenStreetMap model of Gillette, its lots and Route 1.';
}

const ray = new THREE.Raycaster(); const DOWN = new THREE.Vector3(0, -1, 0);
const cellY = new Float32Array(cells.length), lotY = new Float32Array(lots.length);
let groundY = 0;
function sample(x, z) { ray.set(new THREE.Vector3(x, 3000, z), DOWN); const h = ray.intersectObject(tiles.group, true)[0]; return h ? h.point.y : null; }
function resampleHeights() {
  if (!tiles) return;
  const g = sample(0, -300); if (g === null) return;
  groundY = g;
  cells.forEach((c, i) => { const y = sample(c.x, c.z); cellY[i] = (y ?? g) - g; });
  lots.forEach((l, i) => { const y = sample(l.c[0], l.c[1]); lotY[i] = (y ?? g) - g; });
  overlay.position.y = g;
}

// ---------- the 3D layers: what is going wrong, and where ----------
// 1. Each lot is a tank: a column as tall as the cars still in it, stacked
//    amber (trying to leave) / blue (card holders staying) / grey (not left the stadium yet).
const PER_CAR_M = 0.2;
const colGeo = new THREE.BoxGeometry(1, 1, 1); colGeo.translate(0, 0.5, 0);
const colMesh = new THREE.InstancedMesh(colGeo, new THREE.MeshLambertMaterial(), lots.length * 3);
colMesh.frustumCulled = false; overlay.add(colMesh);
const SEG = [new THREE.Color('#f2a516'), new THREE.Color('#5aa9ff'), new THREE.Color('#6b7680')];
const colW = lots.map((l) => THREE.MathUtils.clamp(Math.sqrt(l.capEst) * 1.1, 18, 48));

// 2. Route 1 as a queue: a bar per 40 m stretch and direction, taller and redder when packed.
const roadGeo = new THREE.BoxGeometry(1, 1, 1); roadGeo.translate(0, 0.5, 0);
const roadMesh = new THREE.InstancedMesh(roadGeo, new THREE.MeshLambertMaterial(), cells.length * 2);
roadMesh.frustumCulled = false; overlay.add(roadMesh);
const FREE = new THREE.Color('#34c6a8'), BUSY = new THREE.Color('#f2a516'), FULL = new THREE.Color('#ff4d4d'), tmpC = new THREE.Color();

// 3. The broken part: a red ring where a lot's gate can't let cars out because Route 1 is full,
//    and a red line from the lot to the spot on Route 1 that blocks it.
const ringMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.16, 8, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff4d4d' }), lots.length);
ringMesh.frustumCulled = false; overlay.add(ringMesh);
const linkPos = new Float32Array(lots.length * 6);
const linkGeo = new THREE.BufferGeometry(); linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3));
const links = new THREE.LineSegments(linkGeo, new THREE.LineBasicMaterial({ color: '#ff4d4d' })); links.frustumCulled = false; overlay.add(links);

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);

// ---------- replay state ----------
let conditions = null, lastPlan = null, runs = null, view = 'ours';
let game = null, held = null, cr = null, running = false, paused = false, simAcc = 0;
let cardLabels = [];
const gameOpts = (c) => ({ lanesNorth: 2, lanesSouth: 2, contraflow: !!c.contraflow });
const REAL = realNet(net);

function startReplay(kind) {
  if (!runs) return;
  view = kind;
  const r = runs[kind];
  cr = crowd(net, conditions);
  game = new Game(REAL, { lot: cr.lot, dir: cr.dir, dep: r.dep }, gameOpts(conditions));
  held = r.held; running = true; paused = false; simAcc = 0;
  $('pause').textContent = 'Pause';
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  $('hTitle').textContent = { none: 'No cards', today: "Today's lot (Lot 55)", ours: 'Our lots' }[kind] + (kind === 'none' ? '' : ` · card lots open at ${r.record.plan.releaseMin} min`);
  // label the lots that got cards in this plan
  cardLabels.forEach((o) => overlay.remove(o)); cardLabels = [];
  const cards = r.record.plan.cards || {};
  Object.entries(cards).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([name, n]) => {
    const i = lots.findIndex((l) => l.name === name); if (i < 0) return;
    cardLabels.push(label(`${name.replace('Parking ', '')} · ${fmt(n)} cards`, lots[i].c[0], 30, lots[i].c[1], 'card'));
  });
}

function drawLayers() {
  if (!game) { colMesh.count = 0; roadMesh.count = 0; ringMesh.count = 0; return; }
  colMesh.count = lots.length * 3; roadMesh.count = cells.length * 2; ringMesh.count = lots.length;
  const counts = lots.map(() => [0, 0, 0]);
  const dep = game.cars.dep;
  for (let i = 0; i < game.N; i++) {
    const st = game.state[i]; if (st >= 2) continue;
    const l = cr.lot[i];
    if (st === 1) counts[l][0]++;
    else if (held[i] && game.t > (cr.base[i] - 1)) counts[l][1]++;   // past when it would have left: staying for the card
    else counts[l][2]++;
  }
  let inLots = 0, onRoad = 0, blocked = 0;
  lots.forEach((lot, l) => {
    let y = 0.6 + lotY[l];
    for (let s = 0; s < 3; s++) {
      const h = counts[l][s] * PER_CAR_M; inLots += counts[l][s];
      if (h <= 0.01) { colMesh.setMatrixAt(l * 3 + s, HIDE); continue; }
      M.compose(P.set(lot.c[0], y, lot.c[1]), Q.identity(), S.set(colW[l], h, colW[l]));
      colMesh.setMatrixAt(l * 3 + s, M); colMesh.setColorAt(l * 3 + s, SEG[s]); y += h;
    }
    // blocked gate: cars queued at the gate and the Route 1 stretch it joins is full
    const c = lot.cell, waiting = game.lotQ[l].length > 0;
    const first = game.lotQ[l][0], full = waiting && game.cell[cr.dir[first]][c].length >= JAM * game.lanes[cr.dir[first]];
    if (full) {
      blocked++;
      M.compose(P.set(lot.c[0], 2 + lotY[l], lot.c[1]), Q.identity(), S.setScalar(colW[l] * 0.9 + 10)); ringMesh.setMatrixAt(l, M);
      linkPos.set([lot.c[0], 3 + lotY[l], lot.c[1], cells[c].x, 3 + cellY[c], cells[c].z], l * 6);
    } else { ringMesh.setMatrixAt(l, HIDE); linkPos.fill(0, l * 6, l * 6 + 6); }
  });
  for (let d = 0; d < 2; d++) {
    const jam = JAM * game.lanes[d];
    game.cell[d].forEach((list, ci) => {
      const n = list.length, k = d * cells.length + ci; onRoad += n;
      if (!n) { roadMesh.setMatrixAt(k, HIDE); return; }
      const c = cells[ci], f = Math.min(1, n / jam), side = d === 0 ? 10 : -10;
      Q.setFromAxisAngle(UP, Math.atan2(c.ux, c.uz));
      M.compose(P.set(c.x - c.uz * side, 1 + cellY[ci], c.z + c.ux * side), Q, S.set(14, 6 + f * 110, CELL_M * 0.96));
      roadMesh.setMatrixAt(k, M);
      tmpC.copy(f < 0.5 ? FREE : BUSY).lerp(f < 0.5 ? BUSY : FULL, f < 0.5 ? f * 2 : (f - 0.5) * 2);
      roadMesh.setColorAt(k, tmpC);
    });
  }
  colMesh.instanceMatrix.needsUpdate = true; if (colMesh.instanceColor) colMesh.instanceColor.needsUpdate = true;
  roadMesh.instanceMatrix.needsUpdate = true; if (roadMesh.instanceColor) roadMesh.instanceColor.needsUpdate = true;
  ringMesh.instanceMatrix.needsUpdate = true; linkGeo.attributes.position.needsUpdate = true;
  $('hClock').textContent = Math.round(game.t / 60) + ' min';
  $('hLots').textContent = fmt(inLots); $('hRoad').textContent = fmt(onRoad); $('hGone').textContent = fmt(game.gone); $('hBlocked').textContent = blocked;
}

// ---------- planning (in a worker so the map keeps moving) ----------
const worker = new Worker(new URL('./planWorker.js', import.meta.url), { type: 'module' });
worker.postMessage({ data });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('progress').style.width = Math.round(m.i / m.n * 100) + '%'; return; }
  if (m.type !== 'plan') return;
  lastPlan = m.plan; runs = m.runs;
  $('progress').style.width = '100%';
  $('plan').disabled = false; $('plan').textContent = 'Plan this game';
  $('status').textContent = `Planned for ${fmt(lastPlan.cars)} cars, using ${listEvents().length} past game(s). Numbers below are what actually happened when each plan was played.`;
  showResult(); startReplay('ours');
};

function conditionsFromForm() {
  return { cars: +$('cars').value, trains: +$('train').value, contraflow: $('contra').checked, budget: +$('budget').value, releaseMin: +$('release').value };
}
function plan() {
  conditions = conditionsFromForm();
  $('plan').disabled = true; $('plan').textContent = 'Planning…'; $('progress').style.width = '0';
  $('status').textContent = 'Testing every lot: what if 100 of its cars stayed? This takes a few seconds.';
  const id = `${new Date().toISOString().slice(0, 10)}-g${listEvents().length + 1}`;
  worker.postMessage({ type: 'plan', c: conditions, records: listEvents(), id });
}

function showResult() {
  const R = { none: runs.none.record.result, today: runs.today.record.result, ours: runs.ours.record.result };
  const row = (name, f, key = false) => `<tr${key ? ' class="key"' : ''}><td>${name}</td><td>${f(R.none, 'none')}</td><td>${f(R.today, 'today')}</td><td class="ours">${f(R.ours, 'ours')}</td></tr>`;
  const dash = (k, v) => (k === 'none' ? '–' : v);
  $('rows').innerHTML = [
    row('Avg time sitting in the car', (r) => Math.round(r.avgInCarMin) + ' min'),
    row('Avg time from whistle to highway', (r) => Math.round(r.avgHomeMin) + ' min'),
    row('Cards taken', (r, k) => dash(k, fmt(r.spent / CARD_USD))),
    row('Money spent', (r, k) => dash(k, '$' + fmt(r.spent))),
    row('Car time saved', (r, k) => dash(k, fmt(r.carMinSaved / 60) + ' h')),
    row('Saved per $1,000', (r, k) => dash(k, fmt(r.perThousand) + ' min'), true),
  ].join('');
  const top = Object.entries(lastPlan.ours.cards).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, k]) => `${n} (${k})`).join(', ');
  $('lotsLine').textContent = `Our cards go to northbound drivers in: ${top}${Object.keys(lastPlan.ours.cards).length > 5 ? ', and more' : ''}. They join Route 1 where the queue is worst.`;
  const rt = lastPlan.releaseTest, at = (min) => rt.rows.find((r) => r.min === min);
  const chosen = conditions.releaseMin, adv = at(rt.pick), cur = at(chosen);
  $('advice').textContent = rt.pick === chosen
    ? `Opening the card lots at ${chosen} min fits this game: opening later saves little more.`
    : rt.pick < chosen
      ? `For this game the road clears sooner: opening at ${rt.pick} min gets ${Math.round(adv.carMinSaved / cur.carMinSaved * 100)}% of the benefit and card holders get home ${chosen - rt.pick} min earlier.`
      : `For this game Route 1 is still jammed at ${chosen} min, so card holders drive into it. Opening at ${rt.pick} min saves about ${Math.round((adv.carMinSaved / cur.carMinSaved - 1) * 100)}% more.`;
  $('why').innerHTML = lastPlan.why.map((w) => `<li>${w}</li>`).join('');
  $('resultBox').hidden = false; $('replayBox').hidden = false; $('saveBox').hidden = false; $('save').disabled = false; $('save').textContent = 'Save this game';
}

function renderHistory() {
  const ev = listEvents();
  $('history').innerHTML = ev.length ? ev.map((r) => `<li><strong>${r.id}</strong>: ${fmt(r.conditions.cars)} cars, ${r.conditions.contraflow ? 'contraflow, ' : ''}$${fmt(r.plan.budget)} of cards<br><span>${Math.round(r.result.avgInCarMin)} min in the car on average, ${fmt(r.result.perThousand)} min saved per $1,000; gate speeds counted in ${Object.keys(r.result.exitPerMin || {}).length} lots</span></li>`).join('') : '<li><span>None yet. Plan a game, then save it.</span></li>';
}

// ---------- UI ----------
const outs = { cars: fmt, train: fmt, budget: (v) => `$${fmt(v)} = ${fmt(v / CARD_USD)} cards`, speed: (v) => `1 s = ${v / 60} min` };
for (const id of Object.keys(outs)) { const f = () => ($(id + 'Out').textContent = outs[id](+$(id).value)); $(id).addEventListener('input', f); f(); }
$('plan').addEventListener('click', plan);
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => startReplay(b.dataset.kind)));
$('pause').addEventListener('click', () => { if (!game) return; paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; });
$('restart').addEventListener('click', () => startReplay(view));
$('save').addEventListener('click', () => {
  const r = saveEvent(runs.ours.record);
  $('save').disabled = true; $('save').textContent = r.ok ? `Saved as ${r.id}` : 'Could not save (browser storage blocked)';
  renderHistory();
  $('status').textContent = 'Saved. Plan again: the planner now uses the gate speeds it just measured.';
});
$('clear').addEventListener('click', () => { if (confirm('Forget all saved games in this browser?')) { clearEvents(); renderHistory(); } });
$('export').addEventListener('click', exportEvents);
renderHistory();

function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); tiles?.setResolutionFromRenderer(camera, renderer); }
addEventListener('resize', resize); resize();

let last = performance.now(), sinceSample = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  controls.update(); keepAboveGround(dt);
  if (tiles) {
    camera.updateMatrixWorld(); tiles.update();
    sinceSample += dt; if (sinceSample > 2) { sinceSample = 0; resampleHeights(); }
    const a = tiles.getAttributions?.() || [];
    const txt = a.filter((x) => x.type === 'string').map((x) => x.value).join(' · ');
    if (txt) $('attr').textContent = 'Google · ' + txt + ' · Lots and roads © OpenStreetMap contributors';
  }
  if (running && !paused && game) {
    simAcc += dt * +$('speed').value;
    let steps = 0; while (simAcc >= 3 && steps < 400) { simAcc -= 3; steps++; if (game.step()) { running = false; break; } }
  }
  drawLayers();
  renderer.render(scene, camera); labels.render(scene, camera);
});

plan();
