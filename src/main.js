import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, ReorientationPlugin, TileCompressionPlugin } from '3d-tiles-renderer/three/plugins';
import { buildNet, Game, Season, DT } from './sim.js';

const KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const FANS_PER_CAR = 2.7;   // estimate: fans in each car that comes to a game
const DECK_UP = 3.2, DECK_DOWN = 3.5;   // metres between parking levels above and below ground

const data = await (await fetch('/data/fenway.json')).json();
const net = buildNet(data);
const { cells, lots, links, gateways } = net;
for (const l of lots) l.firstCell = links[net.pathList[Object.values(l.paths)[0][0].id][0]].first;   // the street at its door
const SUPPLY = lots.reduce((a, l) => a + l.capEst, 0);
const SUPPLY_MAX = lots.reduce((a, l) => a + (l.official ? Math.max(l.capEst, l.room ?? 0) : l.capEst), 0);

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
camera.position.set(-520, 980, 1280);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(60, 0, -60);
controls.maxPolarAngle = Math.PI * 0.44;   // never tilt to or below the horizon
controls.screenSpacePanning = false;        // pan along the ground, not up and down
controls.minDistance = 60; controls.maxDistance = 6500;
controls.enableDamping = true;
// The target stays on the ground near the park and the camera stays above whatever is under it
// (the Google ground is not at y = 0, so heights come from the tiles: groundY and a sample under the camera).
let underCam = null, sinceUnder = 0, groundY = 0;
function keepAboveGround(dt) {
  const t = controls.target, g = groundY;
  t.x = THREE.MathUtils.clamp(t.x, data.bounds[0], data.bounds[1]); t.z = THREE.MathUtils.clamp(t.z, data.bounds[2], data.bounds[3]);
  const dy = g - t.y; t.y = g; camera.position.y += dy;          // keep the view when the ground height arrives
  if (tiles && (sinceUnder += dt) > 0.25) { sinceUnder = 0; underCam = sample(camera.position.x, camera.position.z); }
  const floor = Math.max(g, underCam ?? g) + 30;
  if (camera.position.y < floor) camera.position.y = floor;
}
scene.add(new THREE.HemisphereLight('#ffffff', '#4a5560', 1.4));
const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(-1000, 2000, 800); scene.add(sun);

const osm = new THREE.Group(); scene.add(osm);        // shown only without Google tiles
const overlay = new THREE.Group(); scene.add(overlay); // lots, garages, the route network, cars: always shown
const xray = new THREE.Group(); overlay.add(xray);     // parking decks and tunnels, drawn through whatever is on top of them

function shapeOf(pts) { const s = new THREE.Shape(); pts.forEach(([x, z], i) => (i ? s.lineTo(x, -z) : s.moveTo(x, -z))); return s; }
function flatGeom(pts, y) { const g = new THREE.ShapeGeometry(shapeOf(pts)); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return g; }
function flat(pts, color, y, opacity = 1) {
  return new THREE.Mesh(flatGeom(pts, y), new THREE.MeshLambertMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity === 1 }));
}
function line(pts, color, y, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
function ribbonGeom(pts, width, y) {
  const pos = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1, nx = -dz / L * width / 2, nz = dx / L * width / 2;
    pos.push(pts[i][0] + nx, y, pts[i][1] + nz, pts[i][0] - nx, y, pts[i][1] - nz);
  }
  const idx = []; for (let i = 0; i < pts.length - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}
function merged(geoms, material) { const list = geoms.filter(Boolean); const g = list.length ? mergeGeometries(list, false) : null; if (!g) { console.warn('nothing merged', geoms.length, list.length); return new THREE.Group(); } g.computeVertexNormals(); return new THREE.Mesh(g, material); }
function label(text, x, y, z, cls = '') { const d = document.createElement('div'); d.className = 'lbl ' + cls; d.textContent = text; const o = new CSS2DObject(d); o.position.set(x, y, z); overlay.add(o); return o; }

// ---------- OpenStreetMap model view ----------
const [bx0, bx1, bz0, bz1] = data.bounds;
const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(bx1 - bx0 + 3000, bz1 - bz0 + 3000), new THREE.MeshLambertMaterial({ color: '#a9aba3' }));
groundMesh.rotation.x = -Math.PI / 2; groundMesh.position.set((bx0 + bx1) / 2, 0, (bz0 + bz1) / 2); osm.add(groundMesh);
const safe = (f) => { try { return f(); } catch (e) { console.warn('shape skipped', e.message); return null; } };
osm.add(merged(data.water.map((p) => safe(() => flatGeom(p, 0.12))), new THREE.MeshLambertMaterial({ color: '#7d9db4' })));
osm.add(merged(data.parks.map((p) => safe(() => flatGeom(p, 0.08))), new THREE.MeshLambertMaterial({ color: '#89a273' })));
const roadColor = { motorway: '#33383d', trunk: '#3a3f44', primary: '#3a3f44', secondary: '#4b5156', tertiary: '#555b60', residential: '#666c71', unclassified: '#666c71', living_street: '#666c71', service: '#7c8186' };
const roadWidth = { motorway: 14, trunk: 12, primary: 12, secondary: 10, tertiary: 8, residential: 6, unclassified: 6, living_street: 5, service: 3.5 };
const byClass = {};
for (const r of data.roads) {
  if (r.u) continue;   // tunnels are drawn with the x-ray layer
  const c = r.c.replace('_link', ''); (byClass[c] ||= []).push(ribbonGeom(r.p, r.c.endsWith('_link') ? 6 : roadWidth[c] || 4, c === 'service' ? 0.3 : 0.4));
}
for (const [c, geoms] of Object.entries(byClass)) osm.add(merged(geoms, new THREE.MeshBasicMaterial({ color: roadColor[c] || '#777', side: THREE.DoubleSide })));
for (const r of data.rail) if (!r.u) osm.add(line(r.p, '#3b2f2a', 0.9));
const bGeoms = data.buildings.map((b) => safe(() => { const g = new THREE.ExtrudeGeometry(shapeOf(b.p), { depth: b.h, bevelEnabled: false }); g.rotateX(-Math.PI / 2); return g; }));
osm.add(merged(bGeoms, new THREE.MeshLambertMaterial({ color: '#d8d4cc' })));
if (data.stadium) {
  const g = new THREE.ExtrudeGeometry(shapeOf(data.stadium), { depth: 20, bevelEnabled: false }); g.rotateX(-Math.PI / 2);
  osm.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#2f5f47' })));
}

// ---------- overlay: parking, labels ----------
const COL = { lot: '#2b3136', garage: '#d6a84a', underground: '#8e7dff', park: new THREE.Color('#69747e'), wait: new THREE.Color('#f2a516'), road: new THREE.Color('#34c6a8') };
const lotGroup = new THREE.Group(); overlay.add(lotGroup);
const deckMat = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const deckLine = (color) => new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
const levelY = (l, k) => (l.kind === 'underground' ? -(k + 1) * DECK_DOWN : l.kind === 'garage' ? k * DECK_UP : 0);
lots.forEach((l) => {
  const g = new THREE.Group(); l.group = g; lotGroup.add(g);
  if (l.kind === 'surface') {
    g.add(flat(l.p, COL.lot, 0.5, KEY ? 0.35 : 1)); g.add(line(l.p, '#f4f6f2', 1, 0.5));
  } else {
    // footprint on the ground, then one translucent deck for every level, above or below it
    g.add(line(l.p, COL[l.kind], 1.2, 0.9));
    const d = new THREE.Group(); l.decks = d; xray.add(d);
    for (let k = 0; k < l.levels; k++) {
      const y = levelY(l, k) + 0.2;
      const m = new THREE.Mesh(flatGeom(l.p, y), deckMat(COL[l.kind], l.kind === 'underground' ? 0.2 : 0.14)); m.renderOrder = 4; d.add(m);
      const o = new THREE.Line(new THREE.BufferGeometry().setFromPoints(l.p.map(([x, z]) => new THREE.Vector3(x, y, z))), deckLine(COL[l.kind])); o.renderOrder = 5; d.add(o);
    }
  }
  const short = l.name.replace(/\s*\(.*\)/, '');
  l.short = short;
  if (l.capEst >= 100) {
    const top = (l.kind === 'garage' ? l.levels * DECK_UP : 0) + 14;
    l.label = label(short, l.c[0], top, l.c[1], l.kind); l.labelTop = top;
  }
});
for (const r of data.rail) if (r.u) { const o = line(r.p, r.k === 'rail' ? '#c9b8a8' : '#7fd39a', -6, 0.55); o.material.depthTest = false; o.renderOrder = 3; xray.add(o); }
for (const r of data.roads) if (r.u && r.c !== 'service') { const o = line(r.p, '#c8ccd0', -5, 0.5); o.material.depthTest = false; o.renderOrder = 3; xray.add(o); }
label('Fenway Park', 0, 46, 0, 'big');
for (const g of gateways) g.labelObj = label(g.label, g.c[0], 34, g.c[1], 'big exit');
for (const s of data.stations) if (['Kenmore', 'Lansdowne', 'Fenway'].includes(s.n)) label('Ⓣ ' + s.n, s.c[0], 16, s.c[1], 'station');

// Where the lanes of a cell sit relative to its mapped line. A one-way roadway (the Pike, Storrow,
// each side of Commonwealth Ave) is mapped down its own middle, so its lanes straddle the line.
// A two-way street is mapped down the centre line, so traffic keeps to the right of it.
const LANE_W = 3.2;
const laneOffset = (c, lane) => (c.ow ? (lane - (c.lanes - 1) / 2) * LANE_W : 1.7 + lane * LANE_W);
const roadSpan = (c) => (c.ow ? [-c.lanes * LANE_W / 2, c.lanes * LANE_W / 2] : [0.1, 0.1 + c.lanes * LANE_W]);

// Queues: one strip per cell, drawn only where traffic is backing up. It fades in amber as the
// cell fills and turns red when it is full. Moving traffic gets no strip: the cars say enough.
const netGeom = new THREE.BufferGeometry();
const netPos = new Float32Array(cells.length * 12), netCol = new Float32Array(cells.length * 16), netIdx = new Uint32Array(cells.length * 6);
cells.forEach((c, i) => { const k = i * 4; netIdx.set([k, k + 1, k + 2, k + 1, k + 3, k + 2], i * 6); });
netGeom.setAttribute('position', new THREE.BufferAttribute(netPos, 3)); netGeom.setAttribute('color', new THREE.BufferAttribute(netCol, 4)); netGeom.setIndex(new THREE.BufferAttribute(netIdx, 1));
const netMesh = new THREE.Mesh(netGeom, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
netMesh.frustumCulled = false; overlay.add(netMesh);
const cellY = new Float32Array(cells.length);
function layNet() {
  cells.forEach((c, i) => {
    const [lo, hi] = roadSpan(c), rx = -c.uz, rz = c.ux, h = c.len / 2, y = 0.6 + cellY[i], o = i * 12;
    const ax = c.x - c.ux * h, az = c.z - c.uz * h, bxx = c.x + c.ux * h, bzz = c.z + c.uz * h;
    netPos.set([ax + rx * lo, y, az + rz * lo, ax + rx * hi, y, az + rz * hi, bxx + rx * lo, y, bzz + rz * lo, bxx + rx * hi, y, bzz + rz * hi], o);
  });
  netGeom.attributes.position.needsUpdate = true;
}
layNet();
const SLOW = [0.95, 0.65, 0.09], JAMC = [0.9, 0.28, 0.3];
const QUEUE_FROM = 0.35;   // share of a cell's room taken before it counts as a queue
function paintNet() {
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i], f = game && c.len >= 12 ? Math.min(1, game.cell[i].length / c.jam) : 0;   // tiny junction cells are full with one car in them
    const u = Math.max(0, (f - QUEUE_FROM) / (1 - QUEUE_FROM)), a = u > 0 ? 0.18 + 0.37 * u : 0;
    const r = SLOW[0] + (JAMC[0] - SLOW[0]) * u, g = SLOW[1] + (JAMC[1] - SLOW[1]) * u, b = SLOW[2] + (JAMC[2] - SLOW[2]) * u;
    for (let v = 0; v < 4; v++) netCol.set([r, g, b, a], i * 16 + v * 4);
  }
  netGeom.attributes.color.needsUpdate = true;
}

// ---------- Google Photorealistic 3D Tiles ----------
let tiles = null;
if (KEY) {
  tiles = new TilesRenderer('https://tile.googleapis.com/v1/3dtiles/root.json');
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: KEY, autoRefreshToken: true }));
  const draco = new DRACOLoader().setDecoderPath('/draco/');
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new TileCompressionPlugin());
  // Origin at the park, +Y up. Azimuth pi turns the frame so +X is east and +Z is south,
  // matching the OSM coordinates from scripts/build_data.py.
  tiles.registerPlugin(new ReorientationPlugin({ lat: data.origin.lat * THREE.MathUtils.DEG2RAD, lon: data.origin.lon * THREE.MathUtils.DEG2RAD, height: 0, azimuth: Math.PI, recenter: true }));
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  tiles.errorTarget = 12;
  scene.add(tiles.group);
  osm.visible = false;
  tiles.addEventListener('load-error', (e) => {
    console.warn(e);
    if (e.tile && passes > 0) return;   // one bad tile after the map is up is not worth losing the view
    // Fall back to the OSM model so the map never goes blank.
    osm.visible = true; tiles.group.visible = false; tiles = null; groundY = 0; overlay.position.y = 0; cellY.fill(0); layNet(); parkAll();
    $('mode').textContent = 'Google tiles failed to load, so this is the OpenStreetMap model. Check that Map Tiles API is enabled for the key and that the key allows localhost:5173.';
  });
  $('mode').textContent = 'Google Photorealistic 3D Tiles with OpenStreetMap streets, lots and garages.';
} else {
  $('mode').textContent = 'OpenStreetMap model. Add VITE_GOOGLE_MAPS_KEY to .env.local for the photoreal view.';
}

// Street height under the overlay, sampled from the tiles a few points a frame.
// A ray from above hits roofs and overpasses too, so anything far from street level is ignored
// (the Pike under the Prudential Center would otherwise put its cars on the roof).
const ray = new THREE.Raycaster(); ray.firstHitOnly = true; const DOWN = new THREE.Vector3(0, -1, 0);
const rawY = new Float32Array(cells.length).fill(NaN);
let sampleAt = 0, passes = 0;
function sample(x, z) { if (!tiles) return null; ray.set(new THREE.Vector3(x, 3000, z), DOWN); const h = ray.intersectObject(tiles.group, true)[0]; return h ? h.point.y : null; }
function sampleSome() {
  if (!tiles) return;
  const n = passes < 2 ? 160 : 24;
  for (let k = 0; k < n; k++) {
    const c = cells[sampleAt], y = sample(c.x, c.z); rawY[sampleAt] = y ?? NaN;
    if (++sampleAt >= cells.length) { sampleAt = 0; finishPass(); }
  }
}
function finishPass() {
  const near = []; cells.forEach((c, i) => { if (c.ped && !Number.isNaN(rawY[i])) near.push(rawY[i]); });
  if (near.length < 20) return;   // tiles not loaded yet
  near.sort((a, b) => a - b); groundY = near[near.length >> 1]; passes++;
  for (let i = 0; i < cells.length; i++) { const d = rawY[i] - groundY; cellY[i] = Number.isNaN(d) || d < -12 || d > 14 ? 0 : d; }
  overlay.position.y = groundY; layNet(); parkAll();
  lots.forEach((l) => { const y = cellY[l.firstCell]; l.group.position.y = y; if (l.decks) l.decks.position.y = y; if (l.label) l.label.position.y = l.labelTop + y; });
}

// ---------- cars ----------
const MAXN = Math.max(SUPPLY_MAX, 1000);
// A small car, front towards +z, so the way it points is the way it is going: a body with a
// sloped windscreen and a cabin set towards the back, pale headlights in front, red tail lights behind.
const CAR_Y = 0.65;   // wheels this far above the sampled street, clear of the queue strips
function carBody() {
  const side = new THREE.Shape();   // side view: x runs along the car, y is up
  [[-2.3, 0.3], [-2.3, 0.9], [-1.75, 0.95], [-1.2, 1.45], [0.35, 1.45], [1.05, 0.95], [2.2, 0.8], [2.3, 0.3]].forEach(([x, y], i) => (i ? side.lineTo(x, y) : side.moveTo(x, y)));
  const g = new THREE.ExtrudeGeometry(side, { depth: 1.9, bevelEnabled: false });
  g.rotateY(-Math.PI / 2); g.translate(0.95, 0, 0);   // side view x becomes the car's z, the extrusion its width
  return g;
}
function carTrim() {   // the parts that keep their own colour whatever the car's state
  const parts = [];
  const add = (w, h, l, x, y, z, color, tilt = 0) => {
    const g = new THREE.BoxGeometry(w, h, l); if (tilt) g.rotateX(tilt); g.translate(x, y, z);
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); parts.push(g);
  };
  const GLASS = '#1c2429', TYRE = '#15181a';
  add(1.6, 0.05, 0.86, 0, 1.224, 0.717, GLASS, 0.62);      // windscreen
  add(1.6, 0.05, 0.74, 0, 1.222, -1.495, GLASS, -0.738);   // rear window
  for (const x of [-0.955, 0.955]) add(0.04, 0.3, 1.35, x, 1.22, -0.45, GLASS);   // side windows
  add(1.8, 0.14, 0.34, 0, 0.83, 2.1, '#fff3c4');            // headlights, visible from above
  add(1.8, 0.14, 0.3, 0, 0.92, -2.14, '#ff3b30');           // tail lights
  for (const x of [-0.92, 0.92]) for (const z of [-1.45, 1.45]) add(0.26, 0.6, 0.72, x, 0.3, z, TYRE);
  return mergeGeometries(parts, false);
}
const bodyGeom = carBody(), trimGeom = carTrim();
const carMesh = new THREE.InstancedMesh(bodyGeom, new THREE.MeshLambertMaterial(), MAXN);                            // on the street and in surface lots
const carTrimMesh = new THREE.InstancedMesh(trimGeom, new THREE.MeshBasicMaterial({ vertexColors: true }), MAXN);     // their glass, lights and wheels
carTrimMesh.instanceMatrix = carMesh.instanceMatrix;   // same cars, same places: one set of positions for both
const deckCars = new THREE.InstancedMesh(bodyGeom, new THREE.MeshBasicMaterial({ depthTest: false }), MAXN);          // inside garages, above or below ground
for (const m of [carMesh, carTrimMesh, deckCars]) { m.frustumCulled = false; overlay.add(m); }
deckCars.renderOrder = 6;
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S1 = new THREE.Vector3(1, 1, 1), S0 = new THREE.Vector3(0, 0, 0), UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Matrix4().compose(new THREE.Vector3(0, -500, 0), new THREE.Quaternion(), S0);
for (let i = 0; i < MAXN; i++) { carMesh.setMatrixAt(i, ZERO); deckCars.setMatrixAt(i, ZERO); carMesh.setColorAt(i, COL.park); deckCars.setColorAt(i, COL.park); }

// Parking spots, laid out the way a real lot is striped: rows run along the long side of the
// footprint (l.rot, checked against overhead imagery), cars sit across the rows, and rows come in
// back-to-back pairs with a driving aisle between pairs. Small lots that hold more cars than
// striping allows are stack-parked with no aisles, as attendants do on game nights.
function inside(pts, x, z) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
const STALL = 5.5;   // depth of a stall, metres
const LAYOUTS = [
  { pitch: 2.7, rows: [STALL / 2, STALL / 2 + STALL + 7], module: 2 * STALL + 7 },     // striped: 2.7 m stalls, 7 m aisles
  { pitch: 2.5, rows: [STALL / 2, STALL / 2 + STALL + 5.5], module: 2 * STALL + 5.5 }, // tight aisles
  { pitch: 2.4, rows: [2.5], module: 5 },                                              // stacked, no aisles
  { pitch: 2.25, rows: [2.35], module: 4.7 },                                          // bumper to bumper
];
const bBox = data.buildings.map((b) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const [x, z] of b.p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); } return [x0, x1, z0, z1]; });
function buildingsIn(l) {   // buildings standing inside a surface lot's outline: no cars there
  if (l.kind !== 'surface') return [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of l.p) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return data.buildings.filter((b, i) => bBox[i][0] < x1 && bBox[i][1] > x0 && bBox[i][2] < z1 && bBox[i][3] > z0).map((b) => b.p);
}
function layRows(l, pitch, rows, module) {
  const blocks = (l.blocks ||= buildingsIn(l));
  const a = (l.rot ?? 0) * Math.PI / 180, ux = Math.cos(a), uz = Math.sin(a), vx = -uz, vz = ux;   // u along the rows, v across them
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const [x, z] of l.p) { const u = x * ux + z * uz, v = x * vx + z * vz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const fits = (u, v) => [[0, 0], [0, 2.1], [0, -2.1], [0.9, 0], [-0.9, 0]].every(([du, dv]) => {
    const x = (u + du) * ux + (v + dv) * vx, z = (u + du) * uz + (v + dv) * vz;
    return inside(l.p, x, z) && !blocks.some((b) => inside(b, x, z));
  });
  let best = [];
  // slide the row pattern across the lot and along it, and keep the position that fits the most cars
  for (let pv = 0; pv < module; pv += 1) for (const pu of [0, pitch / 2]) {
    const out = [];
    for (let m = v0 - module + pv; m < v1; m += module) for (const r of rows) {
      const v = m + r; if (v < v0 || v > v1) continue;
      for (let u = u0 + pitch / 2 + pu; u < u1; u += pitch) if (fits(u, v)) out.push([u * ux + v * vx, u * uz + v * vz]);
    }
    if (out.length > best.length) best = out;
  }
  return best;
}
const maxCars = (l) => (l.official ? Math.max(l.capEst, l.room ?? 0) : l.capEst);
const spots = lots.map((l) => {
  const need = Math.ceil(maxCars(l) / l.levels);
  let out = [], used = LAYOUTS[0];
  for (const L of LAYOUTS) { used = L; out = layRows(l, L.pitch, L.rows, L.module); if (out.length >= need) break; }
  // more room than cars: widen the stalls so a full lot looks full
  if (out.length > need * 1.08) { const wide = layRows(l, Math.min(used.pitch * 1.6, used.pitch * out.length / need * 0.97), used.rows, used.module); if (wide.length >= need) out = wide; }
  if (!out.length) out = [l.c];
  return out.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));   // the side nearest the park fills first
});
const lotQuat = lots.map((l) => { const a = (l.rot ?? 0) * Math.PI / 180; return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-Math.sin(a), Math.cos(a))); });

let season = null, game = null, running = false, paused = false, simAcc = 0, lastSt = null, hidden = null, frame = 0;
const perLotLeft = new Int32Array(lots.length);
function opts() {
  const west = +$('west').value / 100, north = Math.min(+$('north').value / 100, 0.95 - west);
  return { shareWest: west, shareNorth: north, background: +$('bg').value / 100, police: $('police').checked, remoteShift: +$('remote').value / 100, stayLate: $('stay').checked, trust: 0.6 };
}
function effectiveCars() { return Math.max(0, +$('cars').value - Math.round(+$('train').value / FANS_PER_CAR)); }
const inDeck = (i) => lots[season.lot[i]].kind !== 'surface';

function parkAll() {   // put every car that has not left its lot or garage on its spot
  if (!game) return;
  for (let i = 0; i < game.N; i++) if (game.state[i] < 2) parkOne(i);
  carMesh.instanceMatrix.needsUpdate = true; deckCars.instanceMatrix.needsUpdate = true;
}
function parkOne(i) {
  const li = season.lot[i], l = lots[li], sp = spots[li][Math.floor(season.slot[i] / l.levels) % spots[li].length];
  M.compose(P.set(sp[0], CAR_Y + cellY[l.firstCell] + levelY(l, season.level[i]), sp[1]), lotQuat[li], S1);
  (inDeck(i) ? deckCars : carMesh).setMatrixAt(i, M);
}

function startGame() {
  const N0 = effectiveCars(), o = opts();
  season = new Season(net, { cars: N0, ...o });
  const N = season.N, d = season.departures(season.habit);
  game = new Game(net, { lot: season.lot, path: season.path, dep: d.dep, opt: d.opt }, o);
  lastSt = new Int8Array(N).fill(-1); hidden = new Uint8Array(N);
  for (let i = 0; i < MAXN; i++) { carMesh.setMatrixAt(i, ZERO); deckCars.setMatrixAt(i, ZERO); }
  carMesh.count = N; carTrimMesh.count = N; deckCars.count = N; running = true; paused = false; simAcc = 0;
  parkAll();
  $('pause').textContent = 'Pause';
  const turned = N0 - N;
  $('status').textContent = `Running: ${fmt(N)} cars after ${fmt(+$('cars').value - N0)} fewer from the T.` + (turned > 0 ? ` ${fmt(turned)} more found no space in the model.` : '');
}

function drawCars() {
  if (!game) return;
  const N = game.N, st = game.state; let parked = 0, waiting = 0, onRoad = 0, colS = false, colD = false, matD = false;
  perLotLeft.fill(0);
  for (let i = 0; i < N; i++) {
    const s = st[i];
    if (s < 2) { perLotLeft[season.lot[i]]++; if (s === 0) parked++; else waiting++; }
    if (s === lastSt[i]) continue;
    const deck = inDeck(i);
    if (s < 2) { (deck ? deckCars : carMesh).setColorAt(i, s === 0 ? COL.park : COL.wait); if (deck) colD = true; else colS = true; }
    else if (s === 2) { if (deck) { deckCars.setMatrixAt(i, ZERO); matD = true; } carMesh.setColorAt(i, COL.road); colS = true; }
    else if (!hidden[i]) { carMesh.setMatrixAt(i, ZERO); hidden[i] = 1; }
    lastSt[i] = s;
  }
  for (let ci = 0; ci < cells.length; ci++) {
    const list = game.cell[ci]; if (!list.length) continue;
    const c = cells[ci], L = c.lanes, rows = Math.max(1, Math.ceil(list.length / L)), rx = -c.uz, rz = c.ux;
    Q.setFromAxisAngle(UP, Math.atan2(c.ux, c.uz));
    for (let k = 0; k < list.length; k++) {
      const lane = k % L, row = Math.floor(k / L);
      const along = c.len / 2 - (row + 0.5) * (c.len / rows), lat = laneOffset(c, lane);
      P.set(c.x + c.ux * along + rx * lat, CAR_Y + cellY[ci], c.z + c.uz * along + rz * lat);
      M.compose(P, Q, S1); carMesh.setMatrixAt(list[k], M); onRoad++;
    }
  }
  carMesh.instanceMatrix.needsUpdate = true; if (matD) deckCars.instanceMatrix.needsUpdate = true;
  if (colS && carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;
  if (colD && deckCars.instanceColor) deckCars.instanceColor.needsUpdate = true;
  $('hClock').textContent = Math.round(game.t / 60) + ' min';
  $('hLots').textContent = fmt(parked); $('hWait').textContent = fmt(waiting); $('hRoad').textContent = fmt(onRoad); $('hGone').textContent = fmt(game.gone);
  if (frame % 15 === 0) {
    paintNet();
    lots.forEach((l, i) => { if (!l.label) return; const el = l.label.element, n = perLotLeft[i]; el.textContent = `${l.short} · ${fmt(n)}`; el.classList.toggle('empty', n === 0); });
  }
}

const KIND = { surface: 'surface lots', garage: 'garages', underground: 'underground' };
function finishGame() {
  running = false;
  const s = game.summary(), o = opts();
  const li = document.createElement('li');
  const kinds = Object.entries(s.byKind).map(([k, v]) => `${KIND[k]} ${Math.round(v.avgInCarMin)} min`).join(', ');
  const plan = [`${fmt(game.N)} cars`, `${$('train').value} more fans on the T`, `${Math.round(o.shareWest * 100)}% west, ${Math.round(o.shareNorth * 100)}% north`, `${Math.round(o.background * 100)}% other traffic`];
  if (o.police) plan.push('police waving traffic out');
  if (o.remoteShift) plan.push(`${Math.round(o.remoteShift * 100)}% moved to the official garages`);
  if (o.stayLate) plan.push('stay-late offer on');
  li.innerHTML = `<strong>${Math.round(s.avgInCarMin)} min</strong> in the car on average, <strong>${Math.round(s.avgToStreetMin)}</strong> of them just reaching the street. Final-out rush clear after <strong>${Math.round(s.rushClearMin)} min</strong>.<br><span>By parking: ${kinds}. Slowest: ${s.worst[0] ? `${s.worst[0].name.replace(/\s*\(.*\)/, '')}, ${Math.round(s.worst[0].avgInCarMin)} min` : 'none'}.</span><br><span>${plan.join(', ')}</span>`;
  $('log').prepend(li);
  $('status').textContent = 'Game finished. Change the plan and run again to compare.';
}

// ---------- UI ----------
const outs = { cars: (v) => fmt(v), train: (v) => fmt(v), west: (v) => v + '%', north: (v) => v + '%', bg: (v) => v + '%', remote: (v) => v + '%', speed: (v) => `1 second = ${v >= 60 ? (v / 60) + ' min' : v + ' s'}` };
for (const id of Object.keys(outs)) { const f = () => ($(id + 'Out').textContent = outs[id]($(id).value)); $(id).addEventListener('input', f); f(); }
const southNote = () => { const o = opts(); $('southNote').textContent = `The rest, ${Math.round((1 - o.shareWest - o.shareNorth) * 100)}%, head south (I-93 south, Jamaicaway). Split is an estimate.`; };
$('west').addEventListener('input', southNote); $('north').addEventListener('input', southNote); southNote();
$('cars').max = Math.floor(SUPPLY_MAX / 250) * 250;
$('carsNote').textContent = `The model has game-night room for about ${fmt(SUPPLY)} fan cars within a mile, ${fmt(SUPPLY_MAX)} if the two official garages fill up (estimate).`;
$('train').nextElementSibling.textContent = `About ${Math.round(1000 / FANS_PER_CAR / 10) * 10} fewer cars per 1,000 riders (${FANS_PER_CAR} fans a car, estimate).`;
function setXray() { const on = $('xray').checked; xray.visible = on; deckCars.material.depthTest = !on; deckCars.material.needsUpdate = true; }
$('xray').addEventListener('change', setXray); setXray();
$('run').addEventListener('click', startGame);
$('pause').addEventListener('click', () => { if (!running) return; paused = !paused; $('pause').textContent = paused ? 'Resume' : 'Pause'; });

function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); labels.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); tiles?.setResolutionFromRenderer(camera, renderer); }
addEventListener('resize', resize); resize();

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000); last = now; frame++;
  controls.update(); keepAboveGround(dt);
  if (tiles) {
    camera.updateMatrixWorld(); tiles.update();
    sampleSome();
    const a = tiles?.getAttributions?.() || [];
    const txt = a.filter((x) => x.type === 'string').map((x) => x.value).join(' · ');
    if (txt) $('attr').textContent = 'Google · ' + txt + ' · Streets and parking © OpenStreetMap contributors';
  }
  if (running && !paused) {
    simAcc += dt * +$('speed').value;
    let steps = 0; while (simAcc >= DT && steps < 400) { simAcc -= DT; steps++; if (game.step()) { finishGame(); break; } }
  }
  drawCars();
  renderer.render(scene, camera); labels.render(scene, camera);
});

startGame();
window.__flow = { net, spots, get game() { return game; }, get season() { return season; }, camera, controls, scene };   // for poking at the model from the console
