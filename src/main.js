import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin } from '3d-tiles-renderer/three/plugins';
import { Game, JAM, CELL_M } from './sim.js';
import { buildNet, crowd, gameOpts, TODAY_LOTS, CARD_USD } from './plan.js';

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
let conditions = null, lastPlan = null, runs = null, view = 'plan';
let game = null, held = null, cr = null, running = false, paused = false, simAcc = 0;
// The option we compare against, played on the same clock but not drawn: the plan vs nothing
// extra, every other option vs the plan.
let ghost = null, ghostKind = null;
// Each option is replayed with its own gate speeds (staffed gates are faster) and lanes, so the
// replay matches the planner's numbers.
function gameFor(kind) {
  const r = runs[kind].replay;
  const n = { ...net, lots: net.lots.map((l, i) => ({ ...l, rate: r.rates[i] })) };
  return new Game(n, { lot: cr.lot, dir: cr.dir, dep: r.dep }, gameOpts({ ...conditions, contraflow: r.contraflow }));
}

function startReplay(kind) {
  if (!runs?.[kind]) return;
  view = kind;
  const r = runs[kind];
  cr = crowd(net, conditions);
  game = gameFor(kind);
  // Start paused at the whistle so the screen can be explained before anything moves.
  held = r.replay.held; running = true; paused = true; simAcc = 0;
  ghostKind = kind === 'plan' ? 'none' : 'plan';
  ghost = gameFor(ghostKind);
  $('pause').textContent = 'Play';
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  document.querySelectorAll('#optRows tr[data-kind]').forEach((tr) => tr.classList.toggle('watching', tr.dataset.kind === kind));
  $('hTitle').textContent = 'Watching: ' + r.name + (r.lots.length ? ` · delayed lots open at ${r.releaseMin} min` : '');
  delayedNow = new Set(r.lots); staffedNow = new Set(r.staffed);
  const openBtn = document.querySelector('.jumps [data-open]');
  openBtn.hidden = !r.lots.length; openBtn.dataset.min = String(r.releaseMin + 1);
  if (selected) showInfo(selected);
}

// Advance the shown plan and the comparison plan together.
function stepBoth() {
  const done = game.step();
  if (ghost && !ghost.done) ghost.done = ghost.step();
  return done;
}
// A gate is blocked when cars are queued at it and the Route 1 stretch it joins is full.
function gateBlocked(g, l) {
  const q = g.lotQ[l]; if (!q.length) return false;
  const d = cr.dir[q[0]];
  return g.cell[d][lots[l].cell].length >= JAM * g.lanes[d];
}
// Cars queued at a gate with the engine running (card holders parked on purpose don't count).
function tally(g) {
  let waiting = 0, blocked = 0;
  for (let i = 0; i < g.N; i++) if (g.state[i] === 1) waiting++;
  for (let l = 0; l < lots.length; l++) if (gateBlocked(g, l)) blocked++;
  return { waiting, blocked };
}

// Move the replay to a minute after the game (replaying from the whistle if going back).
function seekTo(min) {
  if (!runs) return;
  if (!game || game.t > min * 60) startReplay(view);
  while (game.t < min * 60) if (stepBoth()) break;
  paused = true; $('pause').textContent = 'Play';
  if (selected) showInfo(selected);
}

// Tower labels: lot name and cars still inside, on top of each tower.
const short = (n) => n.replace('Parking ', '').replace('Unnamed lot', 'Lot #');
const towerLabels = lots.map((l) => { const o = label('', l.c[0], 0, l.c[1], 'tower'); o.visible = false; return o; });
let delayedNow = new Set(), staffedNow = new Set(), lastCounts = null, labelTick = 0, selected = null;

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
  let queued = 0, onRoad = 0, blocked = 0;
  const updLabels = (labelTick = (labelTick + 1) % 10) === 0;
  lastCounts = counts; lastCounts.blocked = [];
  lots.forEach((lot, l) => {
    let y = 0.6 + lotY[l];
    for (let s = 0; s < 3; s++) {
      const h = counts[l][s] * PER_CAR_M; if (s === 0) queued += counts[l][s];
      if (h <= 0.01) { colMesh.setMatrixAt(l * 3 + s, HIDE); continue; }
      M.compose(P.set(lot.c[0], y, lot.c[1]), Q.identity(), S.set(colW[l], h, colW[l]));
      colMesh.setMatrixAt(l * 3 + s, M); colMesh.setColorAt(l * 3 + s, SEG[s]); y += h;
    }
    if (updLabels) {
      const total = counts[l][0] + counts[l][1] + counts[l][2], o = towerLabels[l], delayed = delayedNow.has(lot.name), staffed = staffedNow.has(lot.name);
      o.visible = total >= 300 || delayed || staffed || selected?.lot === l;
      if (o.visible) {
        o.position.y = y + 14;
        o.element.textContent = `${short(lot.name)} · ${fmt(total)} cars${delayed ? ' · DELAYED' : ''}${staffed ? ' · EXTRA STAFF' : ''}`;
        o.element.className = 'lbl tower' + (delayed ? ' card' : '') + (staffed ? ' staff' : '') + (selected?.lot === l ? ' sel' : '');
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
  $('hLots').textContent = fmt(queued); $('hRoad').textContent = fmt(onRoad); $('hGone').textContent = fmt(game.gone); $('hBlocked').textContent = blocked;
  if (ghost) {
    const g = tally(ghost);
    const vs = ghostKind === 'plan' ? 'plan' : 'nothing extra';
    $('hLotsVs').textContent = `vs ${vs}: ${fmt(g.waiting)}`;
    $('hBlockedVs').textContent = `vs ${vs}: ${g.blocked}`;
  }
}

// ---------- planning (in a worker so the map keeps moving) ----------
const worker = new Worker(new URL('./planWorker.js', import.meta.url), { type: 'module' });
worker.postMessage({ data });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'progress') { $('progress').style.width = Math.round(m.i / m.n * 100) + '%'; return; }
  if (m.type !== 'plan') return;
  lastPlan = m.plan; runs = Object.fromEntries(lastPlan.options.map((o) => [o.key, o]));
  $('progress').style.width = '100%';
  $('plan').disabled = false; $('plan').textContent = 'Test these options';
  $('status').textContent = `Tested for ${fmt(lastPlan.cars)} cars. The replay is paused at the whistle.`;
  showResult(); startReplay('plan');
};

function conditionsFromForm() {
  return { cars: +$('cars').value, trains: +$('train').value, zipper: +$('merge').value,
    contraflow: $('contra').checked, staff: +$('staff').value, delayed: $('delayedOn').checked, budget: +$('budget').value, releaseMin: +$('release').value };
}
// picked: the operator's own list of delayed lots, or null for the recommendation.
function plan(picked = null) {
  if (!Array.isArray(picked)) picked = null;
  if (!picked || !conditions) conditions = conditionsFromForm();
  $('plan').disabled = true; $('plan').textContent = 'Testing…'; $('progress').style.width = '0';
  $('testLots').disabled = true; $('testLots').textContent = 'Testing…';
  $('status').textContent = picked ? `Testing your ${picked.length} delayed lots…` : `Playing the night with each option${conditions.delayed ? ' and choosing delayed lots' : ''}. This takes about 20 seconds.`;
  worker.postMessage({ type: 'plan', c: conditions, picked });
}

// ---------- results: every option on the same night, the lot schedule, the delayed lots ----------
function showResult() {
  const none = runs.none.m, p = runs.plan.m;
  const better = (now, before, unit = '') => (now < before ? ` <small class="good">−${fmt(before - now)}${unit}</small>` : '');
  $('headline').innerHTML = lastPlan.options.length > 3 || conditions.contraflow || conditions.staff || conditions.delayed
    ? `<b>${runs.plan.name.replace('Plan: ', 'With ')}</b>: Route 1 is jammed <b>${p.jamMin} min</b> instead of ${none.jamMin}, fans reach the highway in <b>${Math.round(p.avgHomeMin)} min</b> on average instead of ${Math.round(none.avgHomeMin)}, <b>${fmt(p.over60)}</b> drivers sit over an hour in their car instead of ${fmt(none.over60)}, and the last car is out at <b>${p.lastOutMin} min</b> instead of ${none.lastOutMin}.${p.spent ? ` Cards: $${fmt(p.spent)}.` : ''}`
    : 'No option chosen yet: pick one or more in the Plan panel.';
  $('optRows').innerHTML = lastPlan.options.map((o) => {
    const m = o.m, base = o.key === 'none';
    const takes = [o.contraflow && 'police detail for the lane', o.staffed.length && `crew at ${o.staffed.length} gates`, m.spent && `$${fmt(m.spent)} of cards`].filter(Boolean).join(', ') || 'nothing';
    return `<tr data-kind="${o.key}" class="${o.key === 'plan' ? 'key' : ''}"><td>${o.name.replace('Plan: ', '<b>Plan</b>: ')}<small class="takes">Takes: ${takes}</small></td>
      <td>${m.jamMin} min${base ? '' : better(m.jamMin, none.jamMin)}</td>
      <td>${Math.round(m.avgHomeMin)} min${base ? '' : better(Math.round(m.avgHomeMin), Math.round(none.avgHomeMin))}</td>
      <td>${fmt(m.over60)}${base ? '' : better(m.over60, none.over60)}</td>
      <td>${m.lastOutMin} min${base ? '' : better(m.lastOutMin, none.lastOutMin)}</td>
      <td><button type="button" class="watchBtn" data-kind="${o.key}" aria-label="Watch ${o.name}">Watch</button></td></tr>`;
  }).join('');
  const d = runs.delayed?.m || (runs.plan.lots.length ? p : null);
  $('fine').innerHTML = `Every option is played on the same night: same cars, same lots, same road. Gate speeds are estimates (6 to 24 cars a minute per lot) until the venue counts them.${d ? ` Delayed-lot fans wait in the stadium, then sit about <b>${d.heldInCarMin} min</b> in their car (today's Lot 55 fans: ${runs.today.m.heldInCarMin} min, because its gate is slow).` : ''}`;
  renderSchedule();
  const delayedOn = !!conditions.delayed;
  $('delayedBox').hidden = !delayedOn;
  if (delayedOn) {
    const rt = lastPlan.releaseTest, chosen = conditions.releaseMin, at = (min) => rt?.rows.find((r) => r.min === min);
    $('advice').textContent = !rt || !at(chosen) ? '' : rt.pick === chosen
      ? `Opening the delayed lots at ${chosen} min fits this plan: later doesn't cut the over-an-hour count further.`
      : rt.pick < chosen
        ? `Opening at ${rt.pick} min works as well (${fmt(at(rt.pick).over60)} over an hour vs ${fmt(at(chosen).over60)}) and those fans get home ${chosen - rt.pick} min sooner.`
        : `Opening at ${rt.pick} min instead of ${chosen} cuts drivers over an hour from ${fmt(at(chosen).over60)} to ${fmt(at(rt.pick).over60)}: at ${chosen} min the road is still busy.`;
    picked = new Set(runs.plan.lots);
    renderLotList();
  }
  document.querySelector('[data-panel=results]').disabled = false;
  $('player').hidden = false; document.body.classList.add('has-player');
  openPanel('results');
}

// How each lot opens and empties under the plan, against nothing extra (slowest lots first).
function renderSchedule() {
  const none = Object.fromEntries(runs.none.schedule.map((s) => [s.lot, s]));
  const rows = runs.plan.schedule.filter((s) => s.cars >= 50 && s.emptyMin != null).sort((a, b) => none[b.lot].emptyMin - none[a.lot].emptyMin);
  const max = Math.max(...rows.map((s) => Math.max(s.emptyMin, none[s.lot].emptyMin)), 120);
  const pc = (min) => (min / max * 100).toFixed(1) + '%';
  $('schedule').innerHTML = rows.map((s) => {
    const was = none[s.lot].emptyMin, kind = s.delayed ? 'delayed' : s.staffed ? 'staffed' : 'normal';
    const what = s.delayed ? `delayed, opens at ${runs.plan.releaseMin} min` : s.staffed ? `extra staff: gate ${s.gate} cars/min` : `gate ${s.gate} cars/min`;
    return `<li><div class="sname"><b>${s.lot}</b> <small>${fmt(s.cars)} cars · ${what}</small></div>
      <div class="sbar" title="Cars leave from ${s.firstOutMin} to ${s.emptyMin} min; with nothing extra, empty at ${was} min"><i class="${kind}" style="left:${pc(s.firstOutMin)};width:${pc(Math.max(1, s.emptyMin - s.firstOutMin))}"></i><u style="left:${pc(was)}"></u></div>
      <div class="swhen">empty at <b>${s.emptyMin}</b>${was !== s.emptyMin ? ` <small>(was ${was})</small>` : ''}</div></li>`;
  }).join('');
  $('schedScale').innerHTML = [0, 30, 60, 90, 120, 150, 180, 210, 240].filter((m) => m <= max).map((m) => `<span style="left:${pc(m)}">${m}</span>`).join('');
}
$('optRows').addEventListener('click', (e) => {
  const k = e.target.closest?.('.watchBtn')?.dataset.kind; if (!k) return;
  const min = game ? Math.floor(game.t / 60) : 0; startReplay(k); seekTo(min); closePanels();
});

// ---------- the operator switches whole lots on and off ----------
let picked = new Set();
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
function renderLotList() {
  if (!lastPlan) return;
  const rec = new Set(lastPlan.recommended), list = lastPlan.values.filter((v) => v.value > 0 || picked.has(v.lot));
  let cars = 0; for (const v of lastPlan.values) if (picked.has(v.lot)) cars += v.cars;
  $('lotList').innerHTML = list.map((v) => `<li><label><input type="checkbox" data-lot="${v.lot}" ${picked.has(v.lot) ? 'checked' : ''}><span><b>${v.lot}</b>${rec.has(v.lot) ? ' <small class="rec">recommended</small>' : ''}${TODAY_LOTS.includes(v.lot) ? ' <small class="rec today">today</small>' : ''}<br><small>${fmt(v.cars)} cars · $${fmt(v.cost)} · gate ${v.gate} cars/min</small></span></label></li>`).join('');
  const changed = !sameSet(picked, new Set(runs.plan.lots));
  $('lotSum').textContent = `${picked.size} lots, ${fmt(cars)} cars, $${fmt(cars * CARD_USD)} of $${fmt(conditions.budget)}`;
  $('lotSum').classList.toggle('over', cars * CARD_USD > conditions.budget);
  $('testLots').disabled = !changed;
  $('testLots').textContent = changed ? 'Test these lots' : 'Tested';
  $('recLots').hidden = !runs.plan.own && !changed;
}
$('lotList').addEventListener('change', (e) => {
  const n = e.target.dataset?.lot; if (!n) return;
  if (e.target.checked) picked.add(n); else picked.delete(n);
  renderLotList();
});
$('testLots').addEventListener('click', () => plan([...picked]));
$('recLots').addEventListener('click', () => plan(null));
function toggleLot(name) { if (picked.has(name)) picked.delete(name); else picked.add(name); renderLotList(); plan([...picked]); }

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
  const min = Math.round(game.t / 60), r = runs[view], planName = r.name;
  let html;
  if (sel.lot !== undefined) {
    const l = sel.lot, lot = lots[l], [leaving, staying, notYet] = lastCounts[l], delayed = delayedNow.has(lot.name), staffed = staffedNow.has(lot.name);
    const kmFrom = (cells[lot.cell].s / 1000).toFixed(1);
    const v = lastPlan?.values?.find((x) => x.lot === lot.name), s = r.schedule[l], was = runs.none.schedule[l];
    const what = delayed ? `<span class="tag ok">DELAYED LOT</span> Stays closed until ${r.releaseMin} min after the game; every car gets a $50 card${v ? ` (${fmt(v.cars)} cars, $${fmt(v.cost)})` : ''}.`
      : staffed ? `<span class="tag ok">EXTRA STAFF</span> Extra attendants (or a second exit lane) bring its gate to ${s.gate} cars a minute.`
      : '<span class="tag none">NORMAL LOT</span> Cars leave when they are ready.';
    html = `<h3>${lot.name}</h3>
      <p class="k">${lot.side === 'east' ? 'East' : 'West'} of Route 1 · about ${fmt(lot.capEst)} spaces (estimate) · joins Route 1 ${kmFrom} km from the south end</p>
      <p><b>In "${planName}":</b> ${what}</p>
      ${s?.emptyMin != null ? `<p>Empty at <b>${s.emptyMin} min</b> after the game${was && was.emptyMin !== s.emptyMin ? ` (with nothing extra: ${was.emptyMin} min)` : ''}.</p>` : ''}
      <p><b>Minute ${min}:</b> ${fmt(leaving)} drivers in their cars trying to get out, ${fmt(staying)} waiting on purpose (delayed lot), ${fmt(notYet)} not at their car yet.</p>
      <p>Gate: ${lastCounts.blocked[l] ? '<span class="tag">BLOCKED</span> Route 1 outside is full, so nobody can get out right now.' : leaving ? '<span class="tag ok">MOVING</span> cars are getting out.' : '<span class="tag ok">CLEAR</span> no queue.'}</p>
      <p class="k">Gate speed: about ${s?.gate ?? v?.gate} cars a minute (estimate until counted).</p>
      ${conditions.delayed && v && v.cars >= 50 ? `<button class="primary" type="button" id="toggleLot" data-lot="${lot.name}">${picked.has(lot.name) ? 'Make it a normal lot and test' : 'Make it a delayed lot and test'}</button>` : ''}`;
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
  { min: 0, title: 'The final whistle', text: 'Each tower is one parking lot; its height is the cars still in it. White means fans are still in the stadium or walking to their car. About 13,000 cars have to leave through one road, Route 1.' },
  { min: 20, title: 'Everyone heads for the car', text: 'Amber is drivers sitting in their car with the engine running, waiting to get out. Most fans leave in the first 15 minutes, so the towers turn amber together.' },
  { min: 30, title: 'Route 1 fills up', text: 'The bars along Route 1 are the queue, one per 40 m of road. Tall and red means packed. Northbound, to I-95, fills first: 60% of cars go north.' },
  { min: 35, title: 'Blocked gates', text: 'A red ring means that lot cannot let anyone out: the road outside its exit is full. The red line points to the stretch blocking it. Some lots are also slow on their own, because their gate lets out only a few cars a minute.' },
  { min: 45, title: 'What the plan changes', text: 'The contraflow lane gives northbound one more lane, so its bars stay lower. Lots with extra staff (green tags) let cars out faster. Delayed lots (blue) wait in the stadium for $50 and free parking, so they are not on Route 1 during the worst of it.' },
  { min: 45, title: 'Compare at the same minute', text: 'Switch to "Nothing extra" at the bottom: same minute, no options. Count the red rings and the amber towers, then switch back to "Plan". The top right shows both counts side by side.', compare: true },
  { min: 120, title: 'Two hours after the whistle', text: 'With nothing extra, the slowest lots still hold hundreds of cars after two hours. With the plan most lots are empty. The Results panel has the numbers for each option and the lot schedule.' },
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
$('delayedOn').addEventListener('change', () => { $('delayedFields').hidden = !$('delayedOn').checked; });

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
    let steps = 0; while (simAcc >= 3 && steps < 400) { simAcc -= 3; steps++; if (stepBoth()) { running = false; paused = true; $('pause').textContent = 'Play again'; break; } }
    if (selected && (labelTick === 0)) showInfo(selected);
  }
  drawLayers();
  renderer.render(scene, camera); labels.render(scene, camera);
});

plan();
