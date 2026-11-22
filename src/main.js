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
controls.zoomToCursor = true;               // scroll or pinch zooms toward what is under the pointer
controls.zoomSpeed = 1.4;
const HOME = { cam: new THREE.Vector3(-1350, 1000, 1250), target: new THREE.Vector3(-250, 0, -250) };

// Fly the camera smoothly to a new target and distance (click a tower, "Go to a lot", zoom buttons).
let fly = null;
function flyTo(target, dist, camPos = null) {
  const off = camera.position.clone().sub(controls.target);
  if (!camPos) {
    const flatDir = new THREE.Vector3(off.x, 0, off.z).normalize();
    if (!isFinite(flatDir.x)) flatDir.set(-0.7, 0, 0.7);
    const tilt = Math.max(0.55, Math.asin(THREE.MathUtils.clamp(off.y / off.length(), 0, 1)));  // keep at least ~32° from the ground
    camPos = target.clone().addScaledVector(flatDir, Math.cos(tilt) * dist).add(new THREE.Vector3(0, Math.sin(tilt) * dist, 0));
  }
  fly = { t: 0, fromT: controls.target.clone(), fromC: camera.position.clone(), toT: target.clone(), toC: camPos };
}
function stepFly(dt) {
  if (!fly) return;
  fly.t = Math.min(1, fly.t + dt / 0.9);
  const e = fly.t < 0.5 ? 2 * fly.t * fly.t : 1 - (-2 * fly.t + 2) ** 2 / 2;
  controls.target.lerpVectors(fly.fromT, fly.toT, e); camera.position.lerpVectors(fly.fromC, fly.toC, e);
  if (fly.t >= 1) fly = null;
}
function zoomBy(f) {
  const off = camera.position.clone().sub(controls.target);
  const d = THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance);
  flyTo(controls.target.clone(), d, controls.target.clone().addScaledVector(off.normalize(), d));
}
renderer.domElement.addEventListener('pointerdown', () => { fly = null; });   // the user takes over
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
// Bright, saturated colours so the towers read clearly on the grey of the real 3D map.
const SEG = [new THREE.Color('#ffb020'), new THREE.Color('#3d8bff'), new THREE.Color('#eef2f5')];
colMesh.material.emissive = new THREE.Color('#1c1c1c');
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
const gameOpts = (c) => ({ lanesNorth: 2, lanesSouth: 2, contraflow: !!c.contraflow });
const REAL = realNet(net);

function startReplay(kind) {
  if (!runs) return;
  view = kind;
  const r = runs[kind];
  cr = crowd(net, conditions);
  game = new Game(REAL, { lot: cr.lot, dir: cr.dir, dep: r.dep }, gameOpts(conditions));
  // Start paused at the whistle so the screen can be explained before anything moves.
  held = r.held; running = true; paused = true; simAcc = 0;
  $('pause').textContent = 'Play';
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  $('hTitle').textContent = PLAN_NAME[kind] + (kind === 'none' ? '' : ` · ${r.record.plan.lots.length} delayed lot${r.record.plan.lots.length === 1 ? '' : 's'}, open at ${r.record.plan.releaseMin} min`);
  delayedNow = new Set(r.record.plan.lots || []);
  const openBtn = document.querySelector('.jumps [data-open]'); openBtn.dataset.min = String((r.record.plan.releaseMin || 75) + 1);
  if (selected) showInfo(selected);
}

// Move the replay to a minute after the game (replaying from the whistle if going back).
function seekTo(min) {
  if (!runs) return;
  if (!game || game.t > min * 60) startReplay(view);
  while (game.t < min * 60) if (game.step()) break;
  paused = true; $('pause').textContent = 'Play';
  if (selected) showInfo(selected);
}

// Tower labels: lot name and cars still inside, on top of each tower.
const short = (n) => n.replace('Parking ', '').replace('Unnamed lot', 'Lot #');
const towerLabels = lots.map((l) => { const o = label('', l.c[0], 0, l.c[1], 'tower'); o.visible = false; return o; });
let delayedNow = new Set(), lastCounts = null, labelTick = 0, selected = null;
const PLAN_NAME = { none: 'No delayed lots', today: 'Today: Lot 55', ours: 'Plan' };

function drawLayers() {
  if (!game) { colMesh.count = 0; roadMesh.count = 0; ringMesh.count = 0; return; }
  colMesh.count = lots.length * 3; roadMesh.count = cells.length * 2; ringMesh.count = lots.length;
  const counts = lots.map(() => [0, 0, 0]);
  const dep = game.cars.dep;
  for (let i = 0; i < game.N; i++) {
    const st = game.state[i]; if (st >= 2) continue;
    const l = cr.lot[i];
    if (st === 1) counts[l][0]++;
    else if (held[i]) counts[l][1]++;   // in a delayed lot: waiting on purpose until it opens
    else counts[l][2]++;
  }
  let inLots = 0, onRoad = 0, blocked = 0;
  const updLabels = (labelTick = (labelTick + 1) % 10) === 0;
  lastCounts = counts; lastCounts.blocked = [];
  lots.forEach((lot, l) => {
    let y = 0.6 + lotY[l];
    for (let s = 0; s < 3; s++) {
      const h = counts[l][s] * PER_CAR_M; inLots += counts[l][s];
      if (h <= 0.01) { colMesh.setMatrixAt(l * 3 + s, HIDE); continue; }
      M.compose(P.set(lot.c[0], y, lot.c[1]), Q.identity(), S.set(colW[l], h, colW[l]));
      colMesh.setMatrixAt(l * 3 + s, M); colMesh.setColorAt(l * 3 + s, SEG[s]); y += h;
    }
    if (updLabels) {
      const total = counts[l][0] + counts[l][1] + counts[l][2], o = towerLabels[l], delayed = delayedNow.has(lot.name);
      o.visible = total >= 300 || delayed || selected?.lot === l;
      if (o.visible) {
        o.position.y = y + 14;
        o.element.textContent = `${short(lot.name)} · ${fmt(total)} cars${delayed ? ' · DELAYED' : ''}`;
        o.element.className = 'lbl tower' + (delayed ? ' card' : '') + (selected?.lot === l ? ' sel' : '');
      }
    }
    // blocked gate: cars queued at the gate and the Route 1 stretch it joins is full
    const c = lot.cell, waiting = game.lotQ[l].length > 0;
    const first = game.lotQ[l][0], full = waiting && game.cell[cr.dir[first]][c].length >= JAM * game.lanes[cr.dir[first]];
    lastCounts.blocked[l] = full;
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
  $('plan').disabled = false; $('plan').textContent = 'Recommend delayed lots';
  $('status').textContent = `Planned for ${fmt(lastPlan.cars)} cars, using ${listEvents().length} past game(s). ${lastPlan.ours.own ? 'Showing your own lots.' : `Recommended: ${lastPlan.ours.lots.length} delayed lots.`} The replay is paused at the whistle.`;
  showResult(); startReplay('ours');
};

function conditionsFromForm() {
  return { cars: +$('cars').value, trains: +$('train').value, contraflow: $('contra').checked, budget: +$('budget').value, releaseMin: +$('release').value };
}
// picked: the operator's own list of delayed lots, or null for the recommendation.
function plan(picked = null) {
  if (!Array.isArray(picked)) picked = null;
  if (!picked || !conditions) conditions = conditionsFromForm();
  $('plan').disabled = true; $('plan').textContent = 'Planning…'; $('progress').style.width = '0';
  $('testLots').disabled = true; $('testLots').textContent = 'Testing…';
  $('status').textContent = picked ? `Testing your ${picked.length} delayed lots…` : 'Testing every lot as a delayed lot. This takes a few seconds.';
  const id = `${new Date().toISOString().slice(0, 10)}-g${listEvents().length + 1}`;
  worker.postMessage({ type: 'plan', c: conditions, records: listEvents(), id, picked });
}

function showResult() {
  const R = { none: runs.none.record.result, today: runs.today.record.result, ours: runs.ours.record.result };
  const row = (name, f, cls = '') => `<tr class="${cls}"><td>${name}</td><td>${f(R.none, 'none')}</td><td>${f(R.today, 'today')}</td><td class="ours">${f(R.ours, 'ours')}</td></tr>`;
  const cut = (now, before) => (before > 0 && now < before ? ` <small class="good">−${Math.round((1 - now / before) * 100)}%</small>` : '');
  $('rows').innerHTML = [
    row('Route 1 jammed', (r, k) => `${r.jamMin} min${k === 'none' ? '' : cut(r.jamMin, R.none.jamMin)}`, 'key'),
    row('Cars stuck at the worst moment', (r, k) => fmt(r.peakStuck) + (k === 'none' ? '' : cut(r.peakStuck, R.none.peakStuck))),
    row('Gate-minutes blocked', (r, k) => fmt(r.blockedGateMin) + (k === 'none' ? '' : cut(r.blockedGateMin, R.none.blockedGateMin))),
    row('Engine idling, all cars', (r, k) => fmt(r.idleH) + ' h' + (k === 'none' ? '' : cut(r.idleH, R.none.idleH))),
    row('Delayed lots', (r) => r.lots, 'sub'),
    row('Cars held (one $50 card each)', (r) => fmt(r.held), 'sub'),
    row('Card cost', (r) => '$' + fmt(r.spent), 'sub'),
    row('Avg whistle to highway', (r) => Math.round(r.avgHomeMin) + ' min', 'sub'),
  ].join('');
  const o = R.ours, overBudget = o.spent > conditions.budget;
  $('headline').innerHTML = o.jamMin < R.none.jamMin
    ? `<b>${lastPlan.ours.own ? 'Your' : 'The recommended'} ${o.lots} delayed lot${o.lots === 1 ? '' : 's'}</b> keep Route 1 jammed <b>${R.none.jamMin - o.jamMin} min less</b> (${o.jamMin} instead of ${R.none.jamMin}), with ${fmt(R.none.idleH - o.idleH)} fewer hours of engines idling, for $${fmt(o.spent)} of cards. Today's Lot 55: jammed ${R.today.jamMin} min for $${fmt(R.today.spent)}.`
    : `<b>This set of lots does not shorten the jam</b> (${o.jamMin} min vs ${R.none.jamMin} with no delayed lots). Try other lots, or the recommendation.`;
  $('fine').textContent = `Time to the highway stays about the same (${Math.round(o.avgHomeMin)} vs ${Math.round(R.none.avgHomeMin)} min): Route 1 carries the same cars an hour either way. Delayed lots move the wait out of running cars and out of the jam, into the stadium and Patriot Place. Fans in a delayed lot wait about ${o.heldWaitMin} min longer, for $50 and free parking.${overBudget ? ` This set costs $${fmt(o.spent)}, over the $${fmt(conditions.budget)} budget.` : ''}`;
  const rt = lastPlan.releaseTest, at = (min) => rt.rows.find((r) => r.min === min);
  const chosen = conditions.releaseMin, adv = at(rt.pick), cur = at(chosen);
  $('advice').textContent = !rt.rows.length || !cur ? '' : rt.pick === chosen
    ? `Opening the delayed lots at ${chosen} min fits this game: opening later saves little more.`
    : rt.pick < chosen
      ? `For this game the road clears sooner: opening at ${rt.pick} min keeps most of the benefit and those fans get home ${chosen - rt.pick} min earlier.`
      : `For this game Route 1 is still busy at ${chosen} min, so the delayed lots drive into it. Opening at ${rt.pick} min saves ${fmt(adv.idleSavedH - cur.idleSavedH)} more idling hours, and those fans wait ${adv.heldWaitMin - cur.heldWaitMin} min longer.`;
  $('why').innerHTML = lastPlan.why.map((w) => `<li>${w}</li>`).join('');
  picked = new Set(lastPlan.ours.lots);
  renderLotList();
  $('save').disabled = false; $('save').textContent = 'Save this game';
  document.querySelector('[data-panel=results]').disabled = false;
  $('player').hidden = false; document.body.classList.add('has-player');
  openPanel('results');
}

// ---------- the operator switches whole lots on and off ----------
let picked = new Set();
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
function renderLotList() {
  if (!lastPlan) return;
  const rec = new Set(lastPlan.recommended), list = lastPlan.values.filter((v) => v.value > 0 || picked.has(v.lot));
  let cars = 0; for (const v of lastPlan.values) if (picked.has(v.lot)) cars += v.cars;
  $('lotList').innerHTML = list.map((v) => `<li><label><input type="checkbox" data-lot="${v.lot}" ${picked.has(v.lot) ? 'checked' : ''}><span><b>${v.lot}</b>${rec.has(v.lot) ? ' <small class="rec">recommended</small>' : ''}${TODAY_LOTS.includes(v.lot) ? ' <small class="rec today">today</small>' : ''}<br><small>${fmt(v.cars)} cars · $${fmt(v.cost)} · saves ${Math.round(v.value)} idling min per car held</small></span></label></li>`).join('');
  const changed = !sameSet(picked, new Set(lastPlan.ours.lots));
  $('lotSum').textContent = `${picked.size} lots, ${fmt(cars)} cars, $${fmt(cars * CARD_USD)} of $${fmt(conditions.budget)}`;
  $('lotSum').classList.toggle('over', cars * CARD_USD > conditions.budget);
  $('testLots').disabled = !changed;
  $('testLots').textContent = changed ? 'Test these lots' : 'Tested';
  $('recLots').hidden = !lastPlan.ours.own && !changed;
}
$('lotList').addEventListener('change', (e) => {
  const n = e.target.dataset?.lot; if (!n) return;
  if (e.target.checked) picked.add(n); else picked.delete(n);
  renderLotList();
});
$('testLots').addEventListener('click', () => plan([...picked]));
$('recLots').addEventListener('click', () => plan(null));
function toggleLot(name) { if (picked.has(name)) picked.delete(name); else picked.add(name); renderLotList(); plan([...picked]); }

function renderHistory() {
  const ev = listEvents();
  $('memCount').textContent = ev.length || '';
  $('history').innerHTML = ev.length ? ev.map((r) => `<li><strong>${r.id}</strong>: ${fmt(r.conditions.cars)} cars${r.conditions.contraflow ? ', contraflow' : ''}, ${(r.plan.lots || []).length} delayed lots ($${fmt(r.result.spent || 0)})<br><span>${r.result.jamMin !== undefined ? `Route 1 jammed ${r.result.jamMin} min, ${fmt(r.result.idleSavedH || 0)} idling hours saved. ` : ''}Gate speeds counted at ${Object.keys(r.result.exitPerMin || {}).length} lots.</span></li>`).join('') : '<li><span>None yet. Plan a game, then save it.</span></li>';
}

// ---------- click a tower or a road bar to see what is happening there ----------
const picker = new THREE.Raycaster(), pointer = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5 || !game) return; // a drag, not a click
  pointer.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  picker.setFromCamera(pointer, camera);
  const hit = picker.intersectObjects([colMesh, roadMesh], false)[0];
  if (!hit) return;
  selected = hit.object === colMesh ? { lot: Math.floor(hit.instanceId / 3) } : { dir: Math.floor(hit.instanceId / cells.length), cell: hit.instanceId % cells.length };
  if (selected.lot !== undefined) flyToLot(selected.lot);
  else { const c = cells[selected.cell]; flyTo(new THREE.Vector3(c.x, groundY, c.z), 650); }
  showInfo(selected);
});
// Close enough to read the tower: further back for tall towers.
function flyToLot(l) {
  const lot = lots[l], tall = lastCounts ? (lastCounts[l][0] + lastCounts[l][1] + lastCounts[l][2]) * PER_CAR_M : 0;
  flyTo(new THREE.Vector3(lot.c[0], groundY, lot.c[1]), Math.max(420, tall * 2.2));
  $('goto').value = String(l);
}
lots.map((l, i) => [l.name, i]).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  .forEach(([n, i]) => $('goto').add(new Option(n, String(i))));
$('goto').addEventListener('change', () => {
  if ($('goto').value === '') return;
  const l = +$('goto').value; selected = { lot: l }; flyToLot(l); showInfo(selected);
});
$('zoomIn').addEventListener('click', () => zoomBy(0.6));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 0.6));
$('home').addEventListener('click', () => { $('goto').value = ''; flyTo(HOME.target.clone().setY(groundY), 0, HOME.cam.clone().setY(HOME.cam.y + groundY)); });
$('infoClose').addEventListener('click', () => { selected = null; $('info').hidden = true; });
$('info').addEventListener('click', (e) => { const n = e.target.closest?.('#toggleLot')?.dataset.lot; if (n) toggleLot(n); });

function showInfo(sel) {
  if (!game || !lastCounts) return;
  const min = Math.round(game.t / 60), planName = PLAN_NAME[view];
  let html;
  if (sel.lot !== undefined) {
    const l = sel.lot, lot = lots[l], [leaving, staying, notYet] = lastCounts[l], delayed = delayedNow.has(lot.name);
    const kmFrom = (cells[lot.cell].s / 1000).toFixed(1);
    const b = lastPlan?.beliefs?.[l], v = lastPlan?.values?.find((x) => x.lot === lot.name);
    const gate = b?.exitFrom ? `measured at about <b>${Math.round(b.exit)} cars a minute</b> (saved game ${b.exitFrom})` : `assumed <b>15 cars a minute</b> (no gate count saved yet)`;
    const open = runs?.[view]?.record.plan.releaseMin;
    html = `<h3>${lot.name}</h3>
      <p class="k">${lot.side === 'east' ? 'East' : 'West'} of Route 1 · about ${fmt(lot.capEst)} spaces (estimate) · joins Route 1 ${kmFrom} km from the south end</p>
      <p>${delayed ? `<span class="tag ok">DELAYED LOT</span> In "${planName}" this lot stays closed until ${open} min after the game. Every car gets a $50 card${v ? `: ${fmt(v.cars)} cars, $${fmt(v.cost)}` : ''}.` : `<span class="tag none">NORMAL LOT</span> In "${planName}" cars leave when they are ready.`}</p>
      <p><b>Minute ${min}:</b> ${fmt(leaving)} drivers in their cars trying to get out, ${fmt(staying)} waiting on purpose (delayed lot), ${fmt(notYet)} not at their car yet.</p>
      <p>Gate: ${lastCounts.blocked[l] ? '<span class="tag">BLOCKED</span> Route 1 outside is full, so nobody can get out right now.' : leaving ? '<span class="tag ok">MOVING</span> cars are getting out.' : '<span class="tag ok">CLEAR</span> no queue.'}</p>
      <p>Gate speed: ${gate}.</p>
      ${v ? `<p class="k">As a delayed lot, it saves about <b>${Math.round(v.value)} idling minutes per car held</b>, counting everyone it no longer blocks. The plan picks lots where this is highest.</p>` : ''}
      ${v && v.cars >= 50 ? `<button class="primary" type="button" id="toggleLot" data-lot="${lot.name}">${picked.has(lot.name) ? 'Make it a normal lot and test' : 'Make it a delayed lot and test'}</button>` : ''}`;
  } else {
    const n = game.cell[sel.dir][sel.cell].length, cap = JAM * game.lanes[sel.dir], f = n / cap;
    const feeders = lots.filter((x) => (sel.dir === 0 ? x.cell <= sel.cell : x.cell >= sel.cell)).length;
    html = `<h3>Route 1 ${sel.dir === 0 ? 'northbound, to I-95' : 'southbound, to I-495'}</h3>
      <p class="k">40 m stretch, ${(cells[sel.cell].s / 1000).toFixed(1)} km from the south end · ${game.lanes[sel.dir]} lane(s)</p>
      <p><b>Minute ${min}:</b> ${n} cars in this stretch, room for ${cap}.</p>
      <p>${f >= 1 ? '<span class="tag">PACKED</span> Full: cars move at walking pace and lots joining here are blocked.' : f > 0.5 ? '<span class="tag">SLOW</span> Busy: cars are stop-and-go.' : '<span class="tag ok">MOVING</span> Traffic flows.'}</p>
      <p class="k">${feeders} lots feed this direction at or before this point. A full stretch here blocks the gates behind it.</p>`;
  }
  $('infoBody').innerHTML = html; $('info').hidden = false;
}

// ---------- the guided tour: one moment at a time, paused ----------
const TOUR = [
  { min: 0, title: 'The final whistle', text: 'Each tower is one parking lot. Its height is the cars still in it. White means fans are still in the stadium or walking to their car. Blue towers are delayed lots: they stay closed until their opening time and every car in them gets a $50 Visa card. About 13,000 cars need to leave through one road: Route 1.' },
  { min: 20, title: '20 minutes: everyone heads for the car', text: 'Amber is drivers sitting in their car with the engine running, waiting to get out of the lot. Most fans leave in the first 15 minutes, so the towers turn amber together.' },
  { min: 30, title: 'Route 1 fills up', text: 'The bars along Route 1 are the queue: one bar per 40 m of road. Tall and red means packed. The northbound side (to I-95) fills first because 60% of cars go north.' },
  { min: 35, title: 'The broken part: blocked gates', text: 'A red ring means that lot cannot let anyone out, because the road outside its exit is full. The red line points to the stretch blocking it. This is why people sit in the lot for an hour: not the lot itself, the road backing up into it.' },
  { min: 45, title: 'Delayed lots wait on purpose', text: 'The blue towers are delayed lots. Those fans parked free and get a $50 card; they wait in the stadium or at Patriot Place, not in a running car. Their cars are not on Route 1 during the worst of it, so the lots behind them are blocked less. The plan picks the lots whose cars block the most.' },
  { min: 76, title: 'Delayed lots open', text: 'At the opening time the blue towers turn amber and drive out. By now the worst of the jam has passed, so they get out in minutes. Click any tower to see its numbers, or to switch it between delayed and normal.' },
  { min: 45, title: 'Compare the plans', text: 'Switch between No delayed lots, Today: Lot 55, and Plan at the bottom, at the same minute. Count the red rings and look at the height of the Route 1 bars. The Results panel has the numbers.', compare: true },
];
let tourAt = -1;
function tourGo(i) {
  if (!runs) return;
  tourAt = Math.max(0, Math.min(TOUR.length - 1, i));
  const s = TOUR[tourAt];
  seekTo(s.min);
  $('story').hidden = false;
  $('storyStep').textContent = `Step ${tourAt + 1} of ${TOUR.length} · minute ${s.min}`;
  $('storyTitle').textContent = s.title; $('storyText').textContent = s.text;
  $('storyPrev').disabled = tourAt === 0; $('storyNext').textContent = tourAt === TOUR.length - 1 ? 'Done' : 'Next';
}
$('tour').addEventListener('click', () => { closePanels(); tourGo(0); });
$('storyNext').addEventListener('click', () => (tourAt === TOUR.length - 1 ? ($('story').hidden = true) : tourGo(tourAt + 1)));
$('storyPrev').addEventListener('click', () => tourGo(tourAt - 1));
$('storyClose').addEventListener('click', () => ($('story').hidden = true));
document.querySelectorAll('.jumps button').forEach((b) => b.addEventListener('click', () => seekTo(+b.dataset.min)));

// ---------- UI ----------
const outs = { cars: fmt, train: fmt, budget: (v) => `$${fmt(v)} = ${fmt(v / CARD_USD)} cards`, speed: (v) => `1 s = ${v / 60} min` };
for (const id of Object.keys(outs)) { const f = () => ($(id + 'Out').textContent = outs[id](+$(id).value)); $(id).addEventListener('input', f); f(); }
$('plan').addEventListener('click', plan);
// Before / after: switching plans keeps the same minute, so the same moment can be compared.
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  const min = game ? Math.floor(game.t / 60) : 0, wasPaused = paused;
  startReplay(b.dataset.kind); seekTo(min);
  if (!wasPaused) { paused = false; $('pause').textContent = 'Pause'; }
}));
$('pause').addEventListener('click', () => {
  if (!game) return;
  if (!running) { startReplay(view); }           // finished: play again from the whistle
  paused = !paused; $('pause').textContent = paused ? 'Play' : 'Pause';
  if (!paused) closePanels();                    // playing: give the map the whole screen
});
$('watch').addEventListener('click', () => { closePanels(); if (paused) $('pause').click(); });

// ---------- panels: one open at a time, folded back to its icon when done ----------
function openPanel(name) {
  document.querySelectorAll('.dock [data-panel]').forEach((b) => {
    const on = b.dataset.panel === name; b.setAttribute('aria-expanded', String(on)); $('p-' + b.dataset.panel).hidden = !on;
  });
}
function closePanels() { openPanel(null); }
document.querySelectorAll('.dock [data-panel]').forEach((b) => b.addEventListener('click', () => (b.getAttribute('aria-expanded') === 'true' ? closePanels() : openPanel(b.dataset.panel))));
document.querySelectorAll('.drawer [data-close]').forEach((b) => b.addEventListener('click', closePanels));
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePanels(); $('story').hidden = true; } });
openPanel('plan');
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
  stepFly(dt); controls.update(); keepAboveGround(dt);
  if (tiles) {
    camera.updateMatrixWorld(); tiles.update();
    sinceSample += dt; if (sinceSample > 2) { sinceSample = 0; resampleHeights(); }
    const a = tiles.getAttributions?.() || [];
    const txt = a.filter((x) => x.type === 'string').map((x) => x.value).join(' · ');
    if (txt) $('attr').textContent = 'Google · ' + txt + ' · Lots and roads © OpenStreetMap contributors';
  }
  if (running && !paused && game) {
    simAcc += dt * +$('speed').value;
    let steps = 0; while (simAcc >= 3 && steps < 400) { simAcc -= 3; steps++; if (game.step()) { running = false; paused = true; $('pause').textContent = 'Play again'; break; } }
    if (selected && (labelTick === 0)) showInfo(selected);
  }
  drawLayers();
  renderer.render(scene, camera); labels.render(scene, camera);
});

plan();
