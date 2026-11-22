import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin } from '3d-tiles-renderer/three/plugins';
import { buildCells, nearestCell, Game, Season, CELL_M } from './sim.js';

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const RIDERS_PER_CAR = 5000 / 1200; // Foxborough police: a 5,000-rider train keeps ~1,200 cars off Route 1

const data = await (await fetch('/data/foxborough.json')).json();
const { cells } = buildCells(data.route1);
const lots = data.lots.map((l) => ({ ...l, cell: nearestCell(cells, l.c[0], l.c[1]), delayed: false }));
const DELAYED_LOT = lots.findIndex((l) => l.name === 'Lot 55');
const net = { cells, lots };

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
camera.position.set(-900, 1500, 1900);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, -300);
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
  const dy = g - t.y; t.y = g; camera.position.y += dy;          // keep the view when the ground height arrives
  if (tiles && (sinceUnder += dt) > 0.25) { sinceUnder = 0; underCam = sample(camera.position.x, camera.position.z); }
  const floor = Math.max(g, underCam ?? g) + 30;
  if (camera.position.y < floor) camera.position.y = floor;
}
scene.add(new THREE.HemisphereLight('#ffffff', '#4a5560', 1.4));
const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(-1000, 2000, 800); scene.add(sun);

const osm = new THREE.Group(); scene.add(osm);        // shown only without Google tiles
const overlay = new THREE.Group(); scene.add(overlay); // lots, Route 1, cars: always shown

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

// overlay: lots, Route 1 and labels
const lotGroup = new THREE.Group(); overlay.add(lotGroup);
lots.forEach((l, i) => {
  lotGroup.add(flat(l.p, i === DELAYED_LOT ? '#7a5a1a' : '#2b3136', 0.5, KEY ? 0.35 : 1));
  lotGroup.add(line(l.p, '#f4f6f2', 1, 0.5));
  if (l.name && l.capEst > 250) l.label = label(l.name.replace('Parking ', ''), l.c[0], 25, l.c[1], i === DELAYED_LOT ? 'delayed' : '');
});
const r1 = ribbon(data.route1, 20, '#f2a516', 1.2, 0.18); overlay.add(r1);
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
    // Fall back to the OSM model so the map never goes blank.
    osm.visible = true; tiles.group.visible = false;
    $('mode').textContent = 'Google tiles failed to load, so this is the OpenStreetMap model. Check that Map Tiles API is enabled for the key and that the key allows localhost:5173.';
    console.warn(e);
  });
  $('mode').textContent = 'Google Photorealistic 3D Tiles with OpenStreetMap lots and roads.';
} else {
  $('mode').textContent = 'OpenStreetMap model. Add VITE_GOOGLE_MAPS_KEY to .env.local for the photoreal view.';
}

// Ground height under the overlay, sampled from the tiles where they exist.
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
  lotGroup.children.forEach((m) => { /* flat lot shapes follow the stadium ground; small slopes hidden by opacity */ });
}

// ---------- cars ----------
const MAXN = 18000;
const carMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 1.8, 5), new THREE.MeshLambertMaterial(), MAXN);
carMesh.frustumCulled = false; overlay.add(carMesh);
const C = { park: new THREE.Color('#69747e'), wait: new THREE.Color('#f2a516'), road: new THREE.Color('#34c6a8') };
for (let i = 0; i < MAXN; i++) carMesh.setColorAt(i, C.park);
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S1 = new THREE.Vector3(1, 1, 1), S0 = new THREE.Vector3(0, 0, 0), UP = new THREE.Vector3(0, 1, 0);

// parking spots: a 3 m x 10 m grid inside each lot polygon (30 m2 a car, as in the estimate)
function inside(pts, x, z) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
const spots = lots.map((l) => {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of l.p) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
  const out = []; for (let z = minz + 5; z < maxz; z += 10) for (let x = minx + 1.5; x < maxx; x += 3) if (inside(l.p, x, z)) out.push([x, z]);
  return out.length ? out : [l.c];
});

let season = null, game = null, running = false, paused = false, simAcc = 0;
function opts() {
  return { lanesNorth: +$('lanes').value, lanesSouth: 2, contraflow: $('contra').checked, shareNorth: +$('north').value / 100, trust: 0.6 };
}
function effectiveCars() { return Math.max(0, +$('cars').value - Math.round(+$('train').value / RIDERS_PER_CAR)); }

function startGame() {
  lots.forEach((l, i) => (l.delayed = $('delayed').checked && i === DELAYED_LOT));
  const N = effectiveCars(), o = opts();
  season = new Season(net, { cars: N, shareNorth: o.shareNorth, trust: o.trust });
  const d = season.departures(season.habit, 1001);
  game = new Game(net, { lot: season.lot, dir: season.dir, dep: d.dep }, o);
  carMesh.count = N; running = true; paused = false; simAcc = 0;
  $('pause').textContent = 'Pause';
  $('status').textContent = `Running: ${fmt(N)} cars after ${fmt(+$('cars').value - N)} fewer from trains.`;
}

function drawCars() {
  if (!game) return;
  const N = game.N; let inLots = 0, onRoad = 0;
  const lanes = game.lanes;
  for (let i = 0; i < N; i++) {
    const st = game.state[i];
    if (st === 3) { M.compose(P.set(0, -50, 0), Q.identity(), S0); carMesh.setMatrixAt(i, M); continue; }
    if (st < 2) {
      const l = season.lot[i], sp = spots[l][season.slot[i] % spots[l].length];
      M.compose(P.set(sp[0], 1.4 + lotY[l], sp[1]), Q.identity(), S1); carMesh.setMatrixAt(i, M);
      carMesh.setColorAt(i, st === 0 ? C.park : C.wait); inLots++;
    }
  }
  for (let d = 0; d < 2; d++) {
    const L = lanes[d];
    game.cell[d].forEach((list, ci) => {
      const c = cells[ci], hx = d === 0 ? c.ux : -c.ux, hz = d === 0 ? c.uz : -c.uz, rx = -hz, rz = hx;
      Q.setFromAxisAngle(UP, Math.atan2(hx, hz));
      for (let k = 0; k < list.length; k++) {
        const i = list[k], lane = k % L, row = Math.floor(k / L);
        const along = CELL_M / 2 - (row + 0.5) * (CELL_M / Math.max(1, Math.ceil(list.length / L))) ;
        const lat = 2.5 + lane * 3.6;
        P.set(c.x + hx * along + rx * lat, 1.4 + cellY[ci], c.z + hz * along + rz * lat);
        M.compose(P, Q, S1); carMesh.setMatrixAt(i, M); carMesh.setColorAt(i, C.road); onRoad++;
      }
    });
  }
  carMesh.instanceMatrix.needsUpdate = true; carMesh.instanceColor.needsUpdate = true;
  $('hClock').textContent = Math.round(game.t / 60) + ' min';
  $('hLots').textContent = fmt(inLots); $('hRoad').textContent = fmt(onRoad); $('hGone').textContent = fmt(game.gone);
}

function finishGame() {
  running = false;
  const s = game.summary(), o = opts();
  const li = document.createElement('li');
  const plan = `${fmt(game.N)} cars, ${o.lanesNorth}${o.contraflow ? '+1 contraflow' : ''} lanes north, ${$('train').value} on trains, ${$('north').value}% north${$('delayed').checked ? ', delayed lot on' : ''}`;
  li.innerHTML = `<strong>${Math.round(s.avgInCarMin)} min</strong> in the car on average, lots empty after <strong>${Math.round(s.lastOutMin)} min</strong><br><span>${plan}</span>`;
  $('log').prepend(li);
  $('status').textContent = 'Game finished. Change the plan and run again to compare.';
}

// ---------- UI ----------
const outs = { cars: (v) => fmt(v), train: (v) => fmt(v), north: (v) => v + '%', lanes: (v) => v, speed: (v) => `1 second = ${v >= 60 ? (v / 60) + ' min' : v + ' s'}` };
for (const id of Object.keys(outs)) { const f = () => ($(id + 'Out').textContent = outs[id]($(id).value)); $(id).addEventListener('input', f); f(); }
$('run').addEventListener('click', startGame);
$('pause').addEventListener('click', () => { if (!running) return; paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; });

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
  if (running && !paused) {
    simAcc += dt * +$('speed').value;
    let steps = 0; while (simAcc >= 3 && steps < 400) { simAcc -= 3; steps++; if (game.step()) { finishGame(); break; } }
  }
  drawCars();
  renderer.render(scene, camera); labels.render(scene, camera);
});

startGame();
