// Post-game traffic on the real street grid around Fenway Park.
//
// Gillette empties onto one road. Fenway empties into a city: cars start in small surface
// lots, multi-level garages and underground garages, then pick a way out through the grid to
// one of the exits of the map (Storrow Drive, the Mass Pike ramp, Route 9, the bridges...).
//
// Streets: a cell transmission model (Daganzo 1994) run with whole cars, so each car keeps its
// own clock and its own route. Every link of the exit network is cut into cells of about 40 m.
// A cell holds at most lanes * length / JAM_M cars and passes at most its capacity each step, so
// jams spill back through intersections and past garage doors.
// Parking: each lot or garage lets cars out through its exit lanes at a rate set by its type.
// A car parked on level 3 of a garage first has to drive three levels to reach the gate.
// Every rate here is a stated estimate, to be replaced by counts from the city or the garages.

export const CELL_M = 40;          // target cell length, metres
export const DT = 3;               // seconds per step (40 m in 3 s is about 30 mph)
export const JAM_M = 8;            // metres of lane per queued car
export const SAT = 1800;           // cars per lane per hour of green (saturation flow)
// Share of each hour a lane actually moves, by road class: signals, crosswalks, turning cars.
export const GREEN = { motorway: 1, trunk: 0.9, ramp: 0.7, primary: 0.5, secondary: 0.45, tertiary: 0.4, street: 0.3 };
export const POLICE_BOOST = 1.3;   // police waving outbound traffic through: 30% more green
export const LOT_RATE = { surface: 10, garage: 6, underground: 5 };   // cars a minute per exit lane
export const LEVEL_S = { surface: 0, garage: 35, underground: 45 };   // seconds to drive one level
export const WALK_M_MIN = 75;      // walking speed in a crowd, metres a minute
export const PED_ZONE_M = 350;     // streets this close to the park are full of people at first
export const PED_FACTOR = 0.4;     // street capacity left while the crowd is crossing
export const PED_FULL_MIN = 15;    // crowd at full strength until this minute...
export const PED_END_MIN = 30;     // ...and gone by this one
export const OPTIONS = [0, 15, 30, 45, 60, 75, 90]; // minutes after the last out a fan can head for the car
export const STAY_OPT = 3;         // the stay-late offer: head for the car at +45 min
export const STAY_ZONE_M = 450;    // offered in lots and garages within this walk of the park
export const RUSH_HOURS = 0.75;     // most cars try to leave within about 45 minutes
export const CROWD_PENALTY = 1;     // how strongly a street already full of cars pushes the next driver elsewhere
export const ROUTE_SPREAD_S = 400;  // how much a slower way out puts drivers off (seconds; bigger spreads them more)

export function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function pedFactor(tSeconds) {
  const m = tSeconds / 60;
  if (m <= PED_FULL_MIN) return PED_FACTOR;
  if (m >= PED_END_MIN) return 1;
  return PED_FACTOR + (1 - PED_FACTOR) * (m - PED_FULL_MIN) / (PED_END_MIN - PED_FULL_MIN);
}

// Turns the data file into the network the model runs on.
export function buildNet(data) {
  const cells = [];
  const links = data.links.map((L, li) => {
    const pts = L.p, cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = cum[cum.length - 1], n = Math.max(1, Math.round(total / CELL_M)), len = total / n, first = cells.length;
    let j = 0;
    for (let c = 0; c < n; c++) {
      const s = (c + 0.5) * len;
      while (j < pts.length - 2 && cum[j + 1] < s) j++;
      const a = pts[j], b = pts[j + 1], seg = Math.max(1e-6, cum[j + 1] - cum[j]), f = (s - cum[j]) / seg;
      const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
      cells.push({
        x, z, ux: (b[0] - a[0]) / seg, uz: (b[1] - a[1]) / seg, len, link: li, lanes: L.lanes,
        ow: L.ow ? 1 : 0,   // 1: the mapped line is the middle of a one-way roadway. 0: the middle of a two-way street
        cap: L.lanes * SAT * (GREEN[L.cls] ?? GREEN.street) / 3600 * DT,       // cars per step
        jam: Math.max(L.lanes, Math.round(L.lanes * len / JAM_M)),
        next: c < n - 1 ? first + c + 1 : -1,
        ped: Math.hypot(x, z) < PED_ZONE_M ? 1 : 0,
        signal: L.cls === 'motorway' || L.cls === 'trunk' || L.cls === 'ramp' ? 0 : 1,
      });
    }
    return { first, n, cls: L.cls, name: L.n, lanes: L.lanes, len: total, ff: L.ff ?? total / 8,
      capHour: L.lanes * SAT * (GREEN[L.cls] ?? GREEN.street), signal: L.cls === 'motorway' || L.cls === 'trunk' || L.cls === 'ramp' ? 0 : 1 };
  });
  const pathList = [];
  const lots = data.lots.map((l) => {
    const paths = {};
    // up to three different drives to each way out, quickest first
    for (const [gw, alts] of Object.entries(l.paths)) paths[gw] = alts.map((p) => { pathList.push(Int32Array.from(p.l)); return { id: pathList.length - 1, cost: p.t }; });
    return { ...l, paths, capEst: l.fans };
  });
  return { cells, links, lots, gateways: data.gateways, pathList };
}

// One game. cars: { lot: Int16Array, path: Int32Array (index into net.pathList), dep: Float32Array (s),
//                   opt: Int8Array (optional: which leaving time each car chose, 0 = at the final out) }
export class Game {
  constructor(net, cars, opts = {}) {
    this.net = net; this.cars = cars;
    const nc = net.cells.length, N = cars.dep.length;
    this.bg = Math.min(0.9, Math.max(0, opts.background ?? 0.3));   // road capacity used by other city traffic
    this.police = !!opts.police;
    this.t = 0; this.k = 0;
    this.cell = Array.from({ length: nc }, () => []);
    this.tok = new Float32Array(nc); this.recv = new Int16Array(nc);
    this.want = new Int16Array(nc); this.ptr = new Int16Array(nc); this.blocked = new Uint8Array(nc);
    this.MAXW = 12; this.tgt = new Int32Array(nc * this.MAXW);
    this.lotQ = net.lots.map(() => []);
    this.lotTok = new Float32Array(net.lots.length);
    this.lotRate = Float32Array.from(net.lots, (l) => l.exits * (LOT_RATE[l.kind] ?? LOT_RATE.surface) / 60 * DT);
    this.order = Array.from({ length: N }, (_, i) => i).sort((a, b) => cars.dep[a] - cars.dep[b]);
    this.next = 0;
    this.state = new Uint8Array(N);   // 0 parked, 1 queuing to get out of the lot or garage, 2 on the street, 3 gone
    this.where = new Int32Array(N).fill(-1);
    this.hop = new Int16Array(N);     // which link of its path the car is on
    this.enter = new Float32Array(N); // time it reached the street
    this.out = new Float32Array(N);   // time it left the map
    this.gone = 0; this.N = N; this.onStreet = 0; this.stall = 0;
  }

  step() {
    const { cars, net } = this, cells = net.cells, nc = cells.length, t = (this.t += DT);
    const { tok, recv, want, ptr, blocked, tgt, MAXW } = this;
    this.k++;
    while (this.next < this.N && cars.dep[this.order[this.next]] <= t) {
      const i = this.order[this.next++];
      this.state[i] = 1; this.lotQ[cars.lot[i]].push(i);
    }
    // What each cell could send and receive, from where things stand at the start of the step.
    const base = 1 - this.bg, pf = pedFactor(t), pol = this.police ? POLICE_BOOST : 1;
    for (let c = 0; c < nc; c++) {
      const C = cells[c], cap = C.cap * base * (C.signal ? pol : 1) * (C.ped ? pf : 1);
      tok[c] = Math.min(tok[c] + cap, cap + 1);
      const n = this.cell[c].length;
      want[c] = Math.min(n, Math.floor(tok[c]), MAXW); recv[c] = C.jam - n; ptr[c] = 0; blocked[c] = 0;
      // A ring of full blocks would lock solid. After two minutes with nothing moving, an officer
      // waves one car into each full block.
      if (this.stall > 40 && recv[c] < 1) recv[c] = 1;
    }
    let movedNow = 0;
    for (let l = 0; l < this.lotQ.length; l++) this.lotTok[l] = Math.min(this.lotTok[l] + this.lotRate[l], this.lotRate[l] + 1);
    // Hand out the room one car at a time, taking turns, so two streets feeding the same cell
    // (or a garage door and the street it opens onto) merge like a zipper. Cars leave a cell in
    // order: if the first car's next street is full, the cars behind it wait too.
    const fwd = this.k & 1;
    for (let any = true; any;) {
      any = false;
      for (let q = 0; q < nc; q++) {
        const c = fwd ? q : nc - 1 - q;
        if (blocked[c] || ptr[c] >= want[c]) continue;
        const i = this.cell[c][ptr[c]];
        let to = cells[c].next;
        if (to < 0) { const p = net.pathList[cars.path[i]], h = this.hop[i] + 1; to = h < p.length ? net.links[p[h]].first : -2; }
        if (to >= 0 && recv[to] <= 0) { blocked[c] = 1; continue; }
        if (to >= 0) recv[to]--;
        tgt[c * MAXW + ptr[c]++] = to; any = true; movedNow++;
      }
      for (let l = 0; l < this.lotQ.length; l++) {
        const q = this.lotQ[l];
        if (!q.length || this.lotTok[l] < 1) continue;
        // an attendant sends out whichever of the first few cars has room on its street
        for (let j = 0; j < q.length && j < 6; j++) {
          const i = q[j], to = net.links[net.pathList[cars.path[i]][0]].first;
          if (recv[to] <= 0) continue;
          recv[to]--; this.lotTok[l] -= 1; q.splice(j, 1);
          this.cell[to].push(i); this.state[i] = 2; this.where[i] = to; this.hop[i] = 0; this.enter[i] = t;
          this.onStreet++; any = true; movedNow++; break;
        }
      }
    }
    // Move the cars that were given room.
    for (let c = 0; c < nc; c++) {
      const m = ptr[c]; if (!m) continue;
      tok[c] -= m;
      const moved = this.cell[c].splice(0, m), link = cells[c].next < 0;
      for (let j = 0; j < m; j++) {
        const i = moved[j], to = tgt[c * MAXW + j];
        if (to < 0) { this.state[i] = 3; this.out[i] = t; this.where[i] = -1; this.gone++; this.onStreet--; continue; }
        if (link) this.hop[i]++;
        this.where[i] = to; this.cell[to].push(i);
      }
    }
    this.stall = movedNow || !this.onStreet ? 0 : this.stall + 1;
    return this.gone >= this.N;
  }

  runToEnd(maxSeconds = 6 * 3600) {
    while (!this.step() && this.t < maxSeconds) { /* step */ }
    return this.summary();
  }

  summary() {
    const { cars, net } = this; let sum = 0, last = 0, door = 0;
    const kinds = {}, rush = [], perLot = net.lots.map(() => [0, 0]);
    for (let i = 0; i < this.N; i++) {
      const o = this.state[i] === 3 ? this.out[i] : this.t, e = this.state[i] >= 2 ? this.enter[i] : this.t;
      sum += o - cars.dep[i]; door += e - cars.dep[i]; if (o > last) last = o;
      if (!cars.opt || cars.opt[i] === 0) rush.push(o);
      const k = net.lots[cars.lot[i]].kind, K = (kinds[k] ||= { n: 0, sum: 0, door: 0 });
      K.n++; K.sum += o - cars.dep[i]; K.door += e - cars.dep[i];
      perLot[cars.lot[i]][0]++; perLot[cars.lot[i]][1] += o - cars.dep[i];
    }
    // the slowest places to park tonight (ignoring the tiny ones)
    const worst = perLot.map(([n, t], l) => ({ name: net.lots[l].name, kind: net.lots[l].kind, cars: n, avgInCarMin: n ? t / n / 60 : 0 }))
      .filter((x) => x.cars >= 40).sort((a, b) => b.avgInCarMin - a.avgInCarMin).slice(0, 3);
    const byKind = {};
    for (const [k, K] of Object.entries(kinds)) byKind[k] = { cars: K.n, avgInCarMin: K.sum / K.n / 60, avgToStreetMin: K.door / K.n / 60 };
    const n = this.N || 1; rush.sort((a, b) => a - b);
    // The last car is always a fan who stayed for a drink. The rush is the cars that headed out
    // at the final out: it is "clear" when 95% of those have left the map.
    return { avgInCarMin: sum / n / 60, avgToStreetMin: door / n / 60, lastOutMin: last / 60, rushClearMin: (rush[Math.floor(0.95 * (rush.length - 1))] || 0) / 60, finished: this.gone >= this.N, byKind, worst };
  }
}

// How many fan cars each lot holds tonight. The closest places sell out first: lots and garages
// fill completely in order of the walk to the park, and the next one only gets cars once the
// nearer ones are full. If there are still cars left when everything is full, the two official
// garages (Prudential, 100 Clarendon), which are big shared garages, take more, up to their "room".
export function fillLots(lots, N, remoteShift = 0) {
  const cap = lots.map((l) => l.capEst), room = lots.map((l, i) => (l.official ? Math.max(cap[i], l.room ?? 0) : cap[i]));
  const near = lots.map((l, i) => i).sort((a, b) => lots[a].walk - lots[b].walk);
  const n = cap.map(() => 0);
  let left = Math.min(N, room.reduce((a, b) => a + b, 0));
  for (const i of near) { const m = Math.min(left, cap[i]); n[i] = m; left -= m; }
  for (const i of near) { const m = Math.min(left, room[i] - n[i]); n[i] += m; left -= m; }
  // remoteShift moves that share of the cars in close lots out to the official garages
  // (they exit onto other streets), as far as those garages have room.
  if (remoteShift > 0) {
    const far = lots.map((l, i) => (l.official ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < n.length; i++) {
      if (lots[i].official || lots[i].walk > 700) continue;
      let m = Math.round(n[i] * remoteShift);
      for (const f of far) { const r = Math.min(m, room[f] - n[f]); n[f] += r; n[i] -= r; m -= r; }
    }
  }
  return n;
}

// A season: every car belongs to one fan group who heads for the car at a chosen time.
// "remember": after each game a fan keeps a fading record of the cost of each leaving time and
// picks the cheapest one next time, sometimes trying a neighbour. "habit": always leaves as usual.
export class Season {
  constructor(net, opts) {
    this.net = net; this.opts = { ...opts };
    const R = rng(20261122), lots = net.lots;
    const perLot = fillLots(lots, opts.cars, opts.remoteShift ?? 0), N = perLot.reduce((a, b) => a + b, 0);
    this.N = N; this.perLot = perLot;
    this.lot = new Int16Array(N); this.slot = new Int32Array(N); this.level = new Int8Array(N);
    this.path = new Int32Array(N); this.gw = new Int8Array(N); this.habit = new Int8Array(N);
    this.stay = new Uint8Array(N); this.walkS = new Float32Array(N);
    let i = 0;
    for (let l = 0; l < lots.length; l++) for (let k = 0; k < perLot[l]; k++, i++) {
      this.lot[i] = l; this.slot[i] = k;
      this.level[i] = k % lots[l].levels;   // cars spread evenly over the levels
    }
    const shares = [opts.shareWest ?? 0.4, opts.shareNorth ?? 0.35];
    const W = [0.5, 0.2, 0.12, 0.07, 0.05, 0.03, 0.03];   // when fans usually head for the car
    const gws = net.gateways;
    for (let k = 0; k < N; k++) {
      const L = lots[this.lot[k]], u0 = R();
      const region = u0 < shares[0] ? 'west' : u0 < shares[0] + shares[1] ? 'north' : 'south';
      // pick a way out: gateways that serve the fan's direction, weighted towards the quick ones
      let cand = gws.map((g, gi) => gi).filter((gi) => gws[gi].regions[region] && L.paths[gws[gi].id]);
      if (!cand.length) cand = gws.map((g, gi) => gi).filter((gi) => L.paths[gws[gi].id]);
      const best = Math.min(...cand.map((gi) => L.paths[gws[gi].id][0].cost));
      const wt = cand.map((gi) => (gws[gi].regions[region] ?? 0.1) * Math.exp(-(L.paths[gws[gi].id][0].cost - best) / ROUTE_SPREAD_S));
      let u = R() * wt.reduce((a, b) => a + b, 0), c = 0;
      while (c < cand.length - 1 && u > wt[c]) { u -= wt[c]; c++; }
      this.gw[k] = cand[c];
      let v = R(), o = 0; while (o < W.length - 1 && v > W[o]) { v -= W[o]; o++; }
      this.habit[k] = o;
      // leave the seat (2 to 10 min), walk to the car, then drive up or down to the gate
      this.walkS[k] = (2 + R() * 8) * 60 + L.walk / WALK_M_MIN * 60 + this.level[k] * (LEVEL_S[L.kind] ?? 0);
      if (opts.stayLate && L.walk <= STAY_ZONE_M && R() < (opts.stayShare ?? 0.5)) this.stay[k] = 1;
    }
    // Which drive each car takes to its way out. Cars are loaded one at a time in a shuffled
    // order: each takes the drive that is quickest given the cars already sent down every street
    // (drivers look down the block, and police send cars the other way when a street is full).
    const load = new Float32Array(net.links.length), bgf = 1 - Math.min(0.9, opts.background ?? 0.3);
    const capOf = net.links.map((l) => l.capHour * bgf * (l.signal && opts.police ? POLICE_BOOST : 1) * RUSH_HOURS);
    const order = Array.from({ length: N }, (_, k) => k);
    for (let k = N - 1; k > 0; k--) { const j = Math.floor(R() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
    for (const k of order) {
      const alts = lots[this.lot[k]].paths[gws[this.gw[k]].id];
      let bestCost = Infinity, pick = alts[0];
      for (const a of alts) {
        let c = a.cost;
        for (const li of net.pathList[a.id]) { const x = load[li] / capOf[li]; c += net.links[li].ff * CROWD_PENALTY * x * x; }
        if (c < bestCost) { bestCost = c; pick = a; }
      }
      this.path[k] = pick.id;
      for (const li of net.pathList[pick.id]) load[li]++;
    }
    this.choice = Int8Array.from(this.habit);
    this.mem = new Float32Array(N * OPTIONS.length).fill(NaN);
    this.R = R; this.games = []; this.hist = Array.from({ length: N }, () => []);
  }

  departures(choice) {
    const N = choice.length, dep = new Float32Array(N), opt = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const o = this.stay[i] ? Math.max(STAY_OPT, choice[i]) : choice[i];
      opt[i] = o; dep[i] = OPTIONS[o] * 60 + this.walkS[i];
    }
    return { dep, opt };
  }

  // Runs one game for both groups. Returns the two Game objects so the caller can replay one.
  play(opts) {
    Object.assign(this.opts, opts);
    const g = this.games.length + 1;
    const m = this.departures(this.choice), h = this.departures(this.habit);
    const cars = (d) => ({ lot: this.lot, path: this.path, dep: d.dep, opt: d.opt });
    const gm = new Game(this.net, cars(m), this.opts), gh = new Game(this.net, cars(h), this.opts);
    const sm = gm.runToEnd(), sh = gh.runToEnd();
    const trust = this.opts.trust ?? 0.6, K = OPTIONS.length; let changed = 0;
    for (let i = 0; i < this.N; i++) {
      const o = m.opt[i], inCar = ((gm.state[i] === 3 ? gm.out[i] : gm.t) - m.dep[i]) / 60, cost = inCar + 0.5 * OPTIONS[o];
      const k = i * K + o, prev = this.mem[k];
      this.mem[k] = Number.isNaN(prev) ? cost : prev * (1 - trust) + cost * trust;
      let next = this.choice[i];
      if (this.R() < 0.12) next = Math.max(0, Math.min(K - 1, next + (this.R() < 0.5 ? -1 : 1)));
      else { let best = Infinity; for (let j = 0; j < K; j++) { const c = this.mem[i * K + j]; if (!Number.isNaN(c) && c < best) { best = c; next = j; } } }
      if (next !== this.choice[i]) changed++;
      this.hist[i].push({ g, o, inCar });
      this.choice[i] = next;
    }
    const rec = { g, mem: sm, habit: sh, changed: changed / Math.max(1, this.N), opts: { ...this.opts } };
    this.games.push(rec);
    return { rec, replay: { mem: () => new Game(this.net, cars(m), this.opts), habit: () => new Game(this.net, cars(h), this.opts) } };
  }
}
