// Post-game traffic on the real Route 1 centreline.
//
// Road: a cell transmission model (Daganzo 1994), the standard macroscopic traffic model,
// run with whole cars so each car keeps its own clock. Each 40 m cell holds at most
// lanes * JAM cars and passes at most lanes * CAP cars a step, so jams spill back.
// Lots: each lot releases cars onto its join cell at LOT_RATE when the cell has room.
// Merging: when a join cell is full, the cars already on Route 1 and the lots waiting to pull
// out share the space that opens, in proportion to their capacities (the merge rule from
// Daganzo 1995). See ZIPPER.
// Every rate here is a stated estimate, to be replaced by counts from the venue.

export const CELL_M = 40;          // cell length, metres
export const DT = 3;               // seconds per step (40 m at ~30 mph)
export const CAP = 0.5 * DT;       // cars per lane per step (1,800 per lane per hour)
export const JAM = 5;              // cars per lane per cell (about 8 m a car)
export const LOT_RATE = 15 / 60 * DT; // cars per lot exit per step (15 a minute, estimate)
// How a full join cell is shared between Route 1 and the lots pulling out. Estimate.
// 0: cars already on Route 1 always go first, so a lot waits until the road behind it thins out.
// 1: shared by capacity. A 15 a minute gate beside two lanes (60 a minute) gets 15 / 75 = 20%.
// Override per game with opts.zipper.
export const ZIPPER = 1;
export const OPTIONS = [0, 15, 30, 45, 60, 75, 90]; // minutes after the game a car can leave
export const DELAYED_OPT = 5;      // the delayed-release lots leave at +75 min

export function buildCells(route1) {
  // Resample the south-to-north centreline into equal cells.
  const pts = [];
  let acc = 0;
  pts.push({ x: route1[0][0], z: route1[0][1], s: 0 });
  for (let i = 1; i < route1.length; i++) {
    const [ax, az] = route1[i - 1], [bx, bz] = route1[i];
    acc += Math.hypot(bx - ax, bz - az);
    pts.push({ x: bx, z: bz, s: acc });
  }
  const total = acc, n = Math.floor(total / CELL_M), cells = [];
  let j = 0;
  for (let c = 0; c <= n; c++) {
    const s = c * CELL_M;
    while (j < pts.length - 2 && pts[j + 1].s < s) j++;
    const a = pts[j], b = pts[j + 1], f = (s - a.s) / Math.max(1e-6, b.s - a.s);
    cells.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, s });
  }
  for (let c = 0; c < cells.length; c++) {
    const a = cells[Math.max(0, c - 1)], b = cells[Math.min(cells.length - 1, c + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    cells[c].ux = (b.x - a.x) / len; cells[c].uz = (b.z - a.z) / len; // northbound direction
  }
  return { cells, total };
}

export function nearestCell(cells, x, z) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < cells.length; i++) {
    const d = (cells[i].x - x) ** 2 + (cells[i].z - z) ** 2;
    if (d < best) { best = d; bi = i; }
  }
  return bi;
}

export function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// One game. cars: { lot: Int16Array, dir: Uint8Array (0 north, 1 south), dep: Float32Array (s) }
export class Game {
  constructor(net, cars, opts) {
    this.net = net; this.cars = cars;
    this.lanes = [opts.lanesNorth + (opts.contraflow ? 1 : 0), opts.lanesSouth];
    const nc = net.cells.length, N = cars.dep.length;
    this.t = 0;
    this.cell = [Array.from({ length: nc }, () => []), Array.from({ length: nc }, () => [])];
    this.lotQ = net.lots.map(() => []);
    this.lotTok = new Float32Array(net.lots.length);
    // cars a lot releases per step: its own rate if known (cars a minute), else the estimate
    this.lotRate = Float32Array.from(net.lots, (l) => (l.rate ? l.rate / 60 * DT : LOT_RATE));
    this.flowTok = [new Float32Array(nc + 1), new Float32Array(nc + 1)];
    this.zipper = opts.zipper ?? ZIPPER;
    // per direction and join cell: cars the lots can release this step, the gate capacity of
    // those lots, and the space still owed to them
    this.want = [new Uint16Array(nc), new Uint16Array(nc)];
    this.wantRate = [new Float32Array(nc), new Float32Array(nc)];
    this.mergeTok = [new Float32Array(nc), new Float32Array(nc)];
    this.order = Array.from({ length: N }, (_, i) => i).sort((a, b) => cars.dep[a] - cars.dep[b]);
    this.next = 0;
    this.state = new Uint8Array(N);   // 0 parked, 1 waiting in lot, 2 on Route 1, 3 gone
    this.where = new Int32Array(N).fill(-1);
    this.enter = new Float32Array(N); // time it reached Route 1
    this.out = new Float32Array(N);   // time it left the map
    this.gone = 0;
    this.N = N;
  }

  step() {
    const { cars, net } = this, t = (this.t += DT);
    while (this.next < this.N && cars.dep[this.order[this.next]] <= t) {
      const i = this.order[this.next++];
      this.state[i] = 1; this.lotQ[cars.lot[i]].push(i);
    }
    // lots: top up each gate, then note which lots have cars ready to pull out, and which way
    const zip = this.zipper, want = this.want, wantRate = this.wantRate;
    if (zip > 0) for (let d = 0; d < 2; d++) { want[d].fill(0); wantRate[d].fill(0); }
    for (let l = 0; l < this.lotQ.length; l++) {
      const q = this.lotQ[l], r = this.lotRate[l]; this.lotTok[l] = Math.min(this.lotTok[l] + r, r + 1);
      if (!q.length || !(zip > 0)) continue;
      const c = net.lots[l].cell, d = cars.dir[q[0]], n = Math.min(q.length, Math.floor(this.lotTok[l]));
      let j = 0; while (j < n && cars.dir[q[j]] === d) j++;
      want[d][c] += j; wantRate[d][c] += r;
    }
    for (let d = 0; d < 2; d++) {
      const cells = this.cell[d], L = this.lanes[d], nc = cells.length, tok = this.flowTok[d];
      const cap = CAP * L, jam = JAM * L, owedTo = this.mergeTok[d];
      // Boundary k sits downstream of the k-th cell in travel order (direction 0 runs up the
      // index, 1 down). Going downstream first, a cell has already released its own cars when
      // the cell behind it moves in, and it has not yet received any, so a car moves at most
      // one cell a step and a saturated queue still discharges at full capacity.
      for (let k = nc - 1; k >= 0; k--) {
        const from = d === 0 ? k : nc - 1 - k, to = d === 0 ? from + 1 : from - 1;
        tok[k] = Math.min(tok[k] + cap, cap + 1);
        let room = to < 0 || to >= nc ? Infinity : jam - cells[to].length;
        if (zip > 0 && room !== Infinity) {
          // Zipper merge: lots queued at this cell are owed a share of the space it can take
          // this step. Hold back that many spaces from the road when the lots can use them now;
          // they fill them in the lot loop below. Space the lots cannot use stays with the road.
          const gates = wantRate[d][to];
          if (gates > 0) {
            const share = Math.min(1, zip * gates / (gates + cap));
            const owed = Math.min(owedTo[to] + share * Math.min(room, cap), share * cap + 1);
            const hold = Math.min(want[d][to], Math.floor(owed), room);
            owedTo[to] = owed - hold; room -= hold;
          } else owedTo[to] = 0;
        }
        const m = Math.max(0, Math.min(cells[from].length, Math.floor(tok[k]), room));
        if (!m) continue;
        tok[k] -= m;
        const moved = cells[from].splice(0, m);
        if (to < 0 || to >= nc) { for (const i of moved) { this.state[i] = 3; this.out[i] = t; this.gone++; } }
        else { for (const i of moved) this.where[i] = to; cells[to].push(...moved); }
      }
    }
    // lots release onto their join cell when there is room
    for (let l = 0; l < this.lotQ.length; l++) {
      const q = this.lotQ[l];
      if (!q.length) continue;
      const c = net.lots[l].cell;
      while (q.length && this.lotTok[l] >= 1) {
        const i = q[0], d = cars.dir[i], cell = this.cell[d][c];
        if (cell.length >= JAM * this.lanes[d]) break;
        q.shift(); this.lotTok[l] -= 1;
        cell.push(i); this.state[i] = 2; this.where[i] = c; this.enter[i] = t;
      }
    }
    return this.gone >= this.N;
  }

  runToEnd(maxSeconds = 6 * 3600) {
    while (!this.step() && this.t < maxSeconds) { /* step */ }
    return this.summary();
  }

  summary() {
    const { cars } = this; let sum = 0, last = 0;
    for (let i = 0; i < this.N; i++) { const o = this.state[i] === 3 ? this.out[i] : this.t; sum += o - cars.dep[i]; if (o > last) last = o; }
    return { avgInCarMin: this.N ? sum / this.N / 60 : 0, lastOutMin: last / 60 };
  }
}

// A season: every car belongs to one fan group who leaves at a chosen time.
// "remember": after each game a fan keeps a fading record of the cost of each leaving time and
// picks the cheapest one next time, sometimes trying a neighbour. "habit": always leaves as usual.
export class Season {
  constructor(net, opts) {
    this.net = net; this.opts = { ...opts };
    const R = rng(20261123), N = opts.cars;
    const caps = net.lots.map((l) => l.capEst), totalCap = caps.reduce((a, b) => a + b, 0);
    this.lot = new Int16Array(N); this.dir = new Uint8Array(N); this.habit = new Int8Array(N);
    this.delayed = new Uint8Array(N); this.slot = new Int32Array(N);
    // fill lots in proportion to their estimated capacity
    let i = 0; const used = new Int32Array(net.lots.length);
    for (let l = 0; l < net.lots.length && i < N; l++) {
      const want = Math.round(N * caps[l] / totalCap);
      for (let k = 0; k < want && i < N; k++) { this.lot[i] = l; this.slot[i] = used[l]++; i++; }
    }
    for (; i < N; i++) { this.lot[i] = 0; this.slot[i] = used[0]++; }
    const W = [0.55, 0.2, 0.1, 0.05, 0.04, 0.03, 0.03];
    for (let k = 0; k < N; k++) {
      this.dir[k] = R() < opts.shareNorth ? 0 : 1;
      let u = R(), o = 0; while (o < W.length - 1 && u > W[o]) { u -= W[o]; o++; }
      this.habit[k] = o;
    }
    const delayedLot = net.lots.findIndex((l) => l.delayed);
    if (delayedLot >= 0) for (let k = 0; k < N; k++) if (this.lot[k] === delayedLot) this.delayed[k] = 1;
    this.choice = Int8Array.from(this.habit);
    this.mem = new Float32Array(N * OPTIONS.length).fill(NaN);
    this.R = R; this.games = []; this.hist = Array.from({ length: N }, () => []);
  }

  departures(choice, seed) {
    const R = rng(seed), N = choice.length, dep = new Float32Array(N), opt = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      const o = this.delayed[i] ? DELAYED_OPT : choice[i];
      opt[i] = o; dep[i] = (OPTIONS[o] + 3 + R() * 10) * 60; // walk to the car: 3 to 13 min
    }
    return { dep, opt };
  }

  // Runs one game for both groups. Returns the two Game objects so the caller can replay one.
  play(opts) {
    Object.assign(this.opts, opts);
    const g = this.games.length + 1, seed = 1000 + g;
    const m = this.departures(this.choice, seed), h = this.departures(this.habit, seed);
    const cars = (d) => ({ lot: this.lot, dir: this.dir, dep: d.dep });
    const gm = new Game(this.net, cars(m), this.opts), gh = new Game(this.net, cars(h), this.opts);
    const sm = gm.runToEnd(), sh = gh.runToEnd();
    const trust = this.opts.trust, K = OPTIONS.length; let changed = 0;
    for (let i = 0; i < this.lot.length; i++) {
      const o = m.opt[i], inCar = (gm.out[i] - m.dep[i]) / 60, cost = inCar + 0.5 * OPTIONS[o];
      const k = i * K + o, prev = this.mem[k];
      this.mem[k] = Number.isNaN(prev) ? cost : prev * (1 - trust) + cost * trust;
      let next = this.choice[i];
      if (!this.delayed[i]) {
        if (this.R() < 0.12) next = Math.max(0, Math.min(K - 1, next + (this.R() < 0.5 ? -1 : 1)));
        else { let best = Infinity; for (let j = 0; j < K; j++) { const c = this.mem[i * K + j]; if (!Number.isNaN(c) && c < best) { best = c; next = j; } } }
      }
      if (next !== this.choice[i]) changed++;
      this.hist[i].push({ g, o, inCar });
      this.choice[i] = next;
    }
    const rec = { g, mem: sm, habit: sh, changed: changed / this.lot.length, opts: { ...this.opts } };
    this.games.push(rec);
    return { rec, replay: { mem: () => new Game(this.net, cars(m), this.opts), habit: () => new Game(this.net, cars(h), this.opts) } };
  }
}
