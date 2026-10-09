/*
 * Entropy Fakeout: physics core.
 *
 * An event-driven hard-disk gas in a rectangular box. Collisions between
 * disks and with the walls are perfectly elastic and are resolved at the
 * exact instant they happen (no time step, no overlap, no damping), so
 * kinetic energy is conserved to rounding error.
 *
 * The trick: simulate once with no colours, record every frame, then label
 * each particle by which side of the box it is on at the chosen "sort time".
 * Replaying the recording with those labels makes the gas look as if it
 * unmixes itself at that moment.
 *
 * Works both in the browser (window.EntropySim) and in Node (require).
 */
(function (root, factory) {
  const api = factory();
  // The module's own source, so a page can run it in Web Workers. Workers
  // can't load scripts from a file:// page, but they can from a blob.
  api.source = `(${factory.toString()})()`;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EntropySim = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WALL_X = -1; // event partner id for a left/right wall
  const WALL_Y = -2; // event partner id for a top/bottom wall
  const MEMBRANE = -3; // event partner id for the one-way membrane

  const BLUE = 0;
  const RED = 1;

  // Small, fast, seedable PRNG so a seed always gives the same gas.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rand) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  // Binary min-heap of events ordered by time.
  class EventQueue {
    constructor() {
      this.items = [];
    }

    get size() {
      return this.items.length;
    }

    peek() {
      return this.items[0];
    }

    push(event) {
      const items = this.items;
      items.push(event);
      let k = items.length - 1;
      while (k > 0) {
        const parent = (k - 1) >> 1;
        if (items[parent].t <= event.t) break;
        items[k] = items[parent];
        k = parent;
      }
      items[k] = event;
    }

    pop() {
      const items = this.items;
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        let k = 0;
        const n = items.length;
        for (;;) {
          let child = 2 * k + 1;
          if (child >= n) break;
          if (child + 1 < n && items[child + 1].t < items[child].t) child++;
          if (items[child].t >= last.t) break;
          items[k] = items[child];
          k = child;
        }
        items[k] = last;
      }
      return top;
    }
  }

  // Random sequential placement anywhere in the box, using a grid so each
  // overlap check only looks at nearby particles.
  function placeRandom(n, radius, width, height, rand, x, y) {
    const minDist2 = 4 * radius * radius;
    const cell = 2 * radius;
    const cols = Math.max(1, Math.floor(width / cell));
    const rows = Math.max(1, Math.floor(height / cell));
    const grid = new Map();
    const key = (cx, cy) => cy * cols + cx;
    const maxAttempts = 2000;
    for (let i = 0; i < n; i++) {
      let placed = false;
      for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {
        const px = radius + rand() * (width - 2 * radius);
        const py = radius + rand() * (height - 2 * radius);
        const cx = Math.min(cols - 1, Math.floor(px / cell));
        const cy = Math.min(rows - 1, Math.floor(py / cell));
        let clear = true;
        for (let gy = cy - 1; gy <= cy + 1 && clear; gy++) {
          for (let gx = cx - 1; gx <= cx + 1 && clear; gx++) {
            const bucket = grid.get(key(gx, gy));
            if (!bucket) continue;
            for (const j of bucket) {
              const dx = x[j] - px;
              const dy = y[j] - py;
              if (dx * dx + dy * dy < minDist2) {
                clear = false;
                break;
              }
            }
          }
        }
        if (clear) {
          x[i] = px;
          y[i] = py;
          const k = key(cx, cy);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(i);
          placed = true;
        }
      }
      if (!placed) {
        throw new Error(
          `Could not fit ${n} particles of radius ${radius} in the box. Use fewer or smaller particles.`
        );
      }
    }
  }

  /*
   * Half the particles packed into the top-left corner and half into the
   * bottom-right. Each cluster is a hexagonal lattice cut to a quarter disc
   * around its corner, so its size follows from the particle count and
   * radius. Neighbouring particles, and the particles and the walls, are
   * separated by gap × diameter.
   */
  function placeCorners(n, radius, width, height, gap, x, y) {
    const pitch = 2 * radius * (1 + gap); // centre-to-centre distance
    const rowStep = (pitch * Math.sqrt(3)) / 2;
    const margin = radius * (1 + 2 * gap); // wall to first centre
    const topLeft = Math.ceil(n / 2);

    const sites = [];
    for (let row = 0; margin + row * rowStep <= height - margin; row++) {
      const sy = margin + row * rowStep;
      for (let sx = margin + (row % 2) * (pitch / 2); sx <= width - margin; sx += pitch) {
        sites.push([sx, sy, sx * sx + sy * sy]);
      }
    }
    sites.sort((a, b) => a[2] - b[2]);

    const tooCrowded = new Error(
      `${n} particles of radius ${radius} do not fit in two corner clusters. ` +
        'Use fewer or smaller particles, or start them spread out.'
    );
    if (sites.length < topLeft) throw tooCrowded;

    for (let i = 0; i < topLeft; i++) {
      x[i] = sites[i][0];
      y[i] = sites[i][1];
    }
    // The bottom-right cluster is the top-left one rotated half a turn.
    for (let i = topLeft; i < n; i++) {
      x[i] = width - sites[i - topLeft][0];
      y[i] = height - sites[i - topLeft][1];
    }

    // The two clusters must not meet in the middle.
    const minDist2 = pitch * pitch * (1 - 1e-9);
    for (let i = 0; i < topLeft; i++) {
      for (let j = topLeft; j < n; j++) {
        const dx = x[j] - x[i];
        const dy = y[j] - y[i];
        if (dx * dx + dy * dy < minDist2) throw tooCrowded;
      }
    }
  }

  /*
   * Starting positions plus 2D Maxwell-Boltzmann velocities with zero net
   * momentum and the requested RMS speed.
   *
   * start: 'corners' (default) two packed clusters in opposite corners
   *        'random'  spread out at random over the whole box
   * gap:   for 'corners', the space between neighbouring particles as a
   *        fraction of their diameter (default 0.25)
   */
  function createInitialState(opts) {
    const { n, radius, width, height, speed, seed, start = 'corners', gap = 0.25 } = opts;
    if (!(n > 0)) throw new Error('Particle count must be at least 1.');
    if (2 * radius >= Math.min(width, height)) throw new Error('Particles are too big for the box.');
    const rand = mulberry32(seed);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const vx = new Float64Array(n);
    const vy = new Float64Array(n);

    if (start === 'random') placeRandom(n, radius, width, height, rand, x, y);
    else placeCorners(n, radius, width, height, gap, x, y);

    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      vx[i] = gaussian(rand);
      vy[i] = gaussian(rand);
      mx += vx[i];
      my += vy[i];
    }
    mx /= n;
    my /= n;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      if (n > 1) {
        vx[i] -= mx;
        vy[i] -= my;
      }
      sumSq += vx[i] * vx[i] + vy[i] * vy[i];
    }
    const scale = sumSq > 0 ? speed / Math.sqrt(sumSq / n) : 0;
    for (let i = 0; i < n; i++) {
      vx[i] *= scale;
      vy[i] *= scale;
    }

    return { n, radius, width, height, start, gap, x, y, vx, vy };
  }

  // Exactly floor(n / 2) blue particles and the rest red, in random order.
  function randomColours(n, seed) {
    const rand = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    const labels = new Uint8Array(n).fill(RED);
    labels.fill(BLUE, 0, Math.floor(n / 2));
    for (let i = n - 1; i > 0; i--) {
      const k = Math.floor(rand() * (i + 1));
      const tmp = labels[i];
      labels[i] = labels[k];
      labels[k] = tmp;
    }
    return labels;
  }

  /*
   * Event-driven simulator. Each particle keeps exactly one pending event in
   * the queue (its earliest predicted collision). Events carry the collision
   * counts of their particles at prediction time, so an event is stale once
   * either particle has collided since.
   */
  class Simulator {
    constructor(state) {
      this.n = state.n;
      this.r = state.radius;
      this.width = state.width;
      this.height = state.height;
      this.x = Float64Array.from(state.x);
      this.y = Float64Array.from(state.y);
      this.vx = Float64Array.from(state.vx);
      this.vy = Float64Array.from(state.vy);
      this.t = 0;
      this.count = new Uint32Array(this.n);
      this.queue = new EventQueue();
      this.particleCollisions = 0;
      this.wallCollisions = 0;
      this.membraneBounces = 0;
      // Optional one-way membrane: a vertical line at membrane.x that the
      // centres of blue particles may only cross leftwards and those of red
      // ones only rightwards. Particles going the wrong way bounce off it.
      this.membrane = state.membrane
        ? { x: state.membrane.x, labels: state.membrane.labels, on: state.membrane.on !== false }
        : null;
      for (let i = 0; i < this.n; i++) this.predict(i);
    }

    // Switch the membrane on or off mid-run.
    setMembrane(on) {
      if (!this.membrane || this.membrane.on === on) return;
      this.membrane.on = on;
      for (let i = 0; i < this.n; i++) this.count[i]++; // void every pending event
      for (let i = 0; i < this.n; i++) this.predict(i);
    }

    predict(i) {
      const { x, y, vx, vy, r } = this;
      let best = Infinity;
      let partner = WALL_X;

      if (vx[i] > 0) best = (this.width - r - x[i]) / vx[i];
      else if (vx[i] < 0) best = (r - x[i]) / vx[i];

      let dt = Infinity;
      if (vy[i] > 0) dt = (this.height - r - y[i]) / vy[i];
      else if (vy[i] < 0) dt = (r - y[i]) / vy[i];
      if (dt < best) {
        best = dt;
        partner = WALL_Y;
      }

      // Membrane: it acts on particle centres. A particle whose centre is on
      // its own colour's side and heading for the other side bounces when its
      // centre reaches the line, so half of it overlaps the line at that
      // moment. (Equivalently, blue bounces off a wall one radius right of
      // the line and red off one a radius left of it.)
      const m = this.membrane;
      if (m && m.on) {
        dt = Infinity;
        if (m.labels[i] === BLUE) {
          if (x[i] < m.x && vx[i] > 0) dt = (m.x - x[i]) / vx[i];
        } else if (x[i] > m.x && vx[i] < 0) dt = (m.x - x[i]) / vx[i];
        if (dt < best) {
          best = dt;
          partner = MEMBRANE;
        }
      }

      // Time until disks i and j touch. This is the root of
      // |dr + dv t| = 2r, written as gap / (-dvdr + sqrt(d)), which equals
      // -(dvdr + sqrt(d)) / dvdv without its cancellation error for
      // near-grazing collisions.
      const xi = x[i];
      const yi = y[i];
      const vxi = vx[i];
      const vyi = vy[i];
      const sigma2 = 4 * r * r;
      for (let j = 0; j < this.n; j++) {
        if (j === i) continue;
        const dx = x[j] - xi;
        const dy = y[j] - yi;
        const dvx = vx[j] - vxi;
        const dvy = vy[j] - vyi;
        const dvdr = dx * dvx + dy * dvy;
        if (dvdr >= 0) continue; // moving apart
        const gap = dx * dx + dy * dy - sigma2;
        // The root is at least gap / (-2 dvdr). Skip pairs that cannot beat
        // the best so far without the square root. The 1e-9 margin is far
        // larger than any rounding, so this never skips a pair the full
        // calculation would have chosen, and results are unchanged.
        if (gap > best * (-2 * dvdr) * (1 + 1e-9)) continue;
        const dvdv = dvx * dvx + dvy * dvy;
        const d = dvdr * dvdr - dvdv * gap;
        if (d < 0) continue; // they miss
        dt = gap / (-dvdr + Math.sqrt(d));
        if (dt < best) {
          best = dt;
          partner = j;
        }
      }

      if (best === Infinity) return;
      this.queue.push({
        t: this.t + Math.max(0, best),
        i,
        j: partner,
        ci: this.count[i],
        cj: partner >= 0 ? this.count[partner] : 0,
      });
    }

    drift(t) {
      const dt = t - this.t;
      if (dt === 0) return;
      const { x, y, vx, vy, n } = this;
      for (let k = 0; k < n; k++) {
        x[k] += vx[k] * dt;
        y[k] += vy[k] * dt;
      }
      this.t = t;
    }

    // Elastic collision of equal-mass disks: swap the velocity components
    // along the line of centres.
    bounce(i, j) {
      const { x, y, vx, vy } = this;
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const dvdr = dx * (vx[j] - vx[i]) + dy * (vy[j] - vy[i]);
      const k = dvdr / (dx * dx + dy * dy);
      vx[i] += k * dx;
      vy[i] += k * dy;
      vx[j] -= k * dx;
      vy[j] -= k * dy;
    }

    advanceTo(tEnd) {
      const q = this.queue;
      while (q.size > 0 && q.peek().t <= tEnd) {
        const e = q.pop();
        const { i, j } = e;
        if (e.ci !== this.count[i]) continue; // i already has a newer event
        this.drift(e.t);
        if (j >= 0) {
          if (e.cj !== this.count[j]) {
            // The partner changed course, so this prediction is void.
            this.predict(i);
            continue;
          }
          this.bounce(i, j);
          this.count[i]++;
          this.count[j]++;
          this.particleCollisions++;
          this.predict(i);
          this.predict(j);
        } else {
          if (j === WALL_Y) this.vy[i] = -this.vy[i];
          else this.vx[i] = -this.vx[i];
          this.count[i]++;
          if (j === MEMBRANE) this.membraneBounces++;
          else this.wallCollisions++;
          this.predict(i);
        }
      }
      this.drift(tEnd);
    }

    // An independent copy with the same state and pending events. Advanced
    // the same way, it follows the original bit for bit; the original is
    // unaffected. (Events are never modified once queued, so the copy can
    // share them.)
    clone() {
      const c = Object.create(Simulator.prototype);
      Object.assign(c, this);
      c.x = this.x.slice();
      c.y = this.y.slice();
      c.vx = this.vx.slice();
      c.vy = this.vy.slice();
      c.count = this.count.slice();
      c.queue = new EventQueue();
      c.queue.items = this.queue.items.slice();
      c.membrane = this.membrane ? { ...this.membrane } : null;
      return c;
    }

    kineticEnergy() {
      let e = 0;
      for (let k = 0; k < this.n; k++) e += this.vx[k] * this.vx[k] + this.vy[k] * this.vy[k];
      return 0.5 * e;
    }
  }

  /*
   * Run the simulation and store every particle position at every frame.
   * frames[(f * n + i) * 2] is x, the next entry is y.
   *
   * Pass onProgress to receive (doneFrames, totalFrames); return a promise
   * from it to let the caller yield (e.g. to keep a page responsive).
   */
  async function record(state, opts) {
    const { duration, fps, onProgress, chunk = 30, snapshotEvery = 60 } = opts;
    const sim = new Simulator(state);
    const n = state.n;
    const frameCount = Math.floor(duration * fps + 1e-9) + 1;
    const frames = new Float32Array(frameCount * n * 2);
    const snapshots = []; // the simulator every snapshotEvery frames, for Replay
    const energyStart = sim.kineticEnergy();
    for (let f = 0; f < frameCount; f++) {
      sim.advanceTo(f / fps);
      if (f % snapshotEvery === 0) snapshots.push(sim.clone());
      const base = f * n * 2;
      for (let i = 0; i < n; i++) {
        frames[base + 2 * i] = sim.x[i];
        frames[base + 2 * i + 1] = sim.y[i];
      }
      if (onProgress && (f + 1) % chunk === 0) await onProgress(f + 1, frameCount);
    }
    if (onProgress) await onProgress(frameCount, frameCount);
    return {
      n,
      radius: state.radius,
      width: state.width,
      height: state.height,
      start: state.start,
      gap: state.gap,
      fps,
      frameCount,
      frames,
      snapshots,
      snapshotEvery,
      particleCollisions: sim.particleCollisions,
      wallCollisions: sim.wallCollisions,
      energyStart,
      energyEnd: sim.kineticEnergy(),
    };
  }

  /*
   * Exact positions at any time in a recording, including between frames,
   * for smooth slow motion. It re-simulates from the nearest snapshot,
   * stepping frame by frame exactly as record() did so it stays on the
   * recorded trajectory, then advances a throwaway copy to the requested
   * time. Playing forward only ever steps a frame or two at a time.
   */
  class Replay {
    constructor(rec) {
      this.rec = rec;
      this.sim = null;
      this.frame = -1;
    }

    // A simulator positioned at the given time; read its x and y.
    at(time) {
      const { fps, frameCount, snapshots, snapshotEvery } = this.rec;
      const end = (frameCount - 1) / fps;
      time = Math.max(0, Math.min(end, time));
      const k = Math.min(frameCount - 1, Math.floor(time * fps + 1e-9));
      if (!this.sim || k < this.frame || k - this.frame > snapshotEvery) {
        const s = Math.floor(k / snapshotEvery);
        this.sim = snapshots[s].clone();
        this.frame = s * snapshotEvery;
      }
      while (this.frame < k) {
        this.frame++;
        this.sim.advanceTo(this.frame / fps);
      }
      const view = this.sim.clone();
      view.advanceTo(time);
      return view;
    }
  }

  /*
   * Colour the particles from their positions at the sort time, so that
   * every blue particle is left of every red one at exactly that frame.
   *
   * split: 'even'   exactly half of each colour; the dividing line falls
   *                 midway between the two middle particles, which is near
   *                 (but not exactly on) the centre of the box.
   *        'centre' the dividing line is the centre of the box; the two
   *                 colours can differ in number by a few particles.
   */
  function assignColours(rec, sortTime, split = 'even') {
    const { n, frames, fps, frameCount, width } = rec;
    const frame = Math.max(0, Math.min(frameCount - 1, Math.round(sortTime * fps)));
    const { labels, boundary } = labelFrame(frames, frame * n * 2, n, width, split);
    return { labels, frame, time: frame / fps, split, boundary };
  }

  function labelFrame(frames, base, n, width, split) {
    const labels = new Uint8Array(n);
    let boundary = width / 2;

    if (split === 'centre') {
      for (let i = 0; i < n; i++) labels[i] = frames[base + 2 * i] < boundary ? BLUE : RED;
    } else {
      const order = Array.from({ length: n }, (_, i) => i);
      order.sort((a, b) => frames[base + 2 * a] - frames[base + 2 * b]);
      const blues = Math.floor(n / 2);
      order.forEach((i, rank) => {
        labels[i] = rank < blues ? BLUE : RED;
      });
      if (blues > 0 && blues < n) {
        boundary = (frames[base + 2 * order[blues - 1]] + frames[base + 2 * order[blues]]) / 2;
      }
    }
    return { labels, boundary };
  }

  // Fraction of particles on "their" side of the dividing line: blue left,
  // red right. About 0.5 when mixed, exactly 1 at the sort time.
  function sortedness(rec, labels, boundary) {
    const out = new Float32Array(rec.frameCount);
    for (let f = 0; f < rec.frameCount; f++) out[f] = sortednessAt(rec, labels, boundary, f);
    return out;
  }

  function sortednessAt(rec, labels, boundary, f) {
    const { n, frames } = rec;
    const base = f * n * 2;
    let good = 0;
    for (let i = 0; i < n; i++) {
      const left = frames[base + 2 * i] < boundary;
      if (left === (labels[i] === BLUE)) good++;
    }
    return good / n;
  }

  /*
   * How grouped the colours are within each corner cluster at the start: the
   * share of neighbouring pairs (adjacent in the packing) that have the same
   * colour. About 0.5 for a random mix, 1 when each colour sits in its own
   * patch. Returns { topLeft, bottomRight, worst } for a corner start, or
   * null otherwise. frames/base locate the opening frame.
   */
  function clumpiness(frames, base, n, labels, layout) {
    if (layout.start === 'random') return null;
    // Packing neighbours are one pitch apart; the next nearest are sqrt(3)
    // pitches away, so 1.5 pitches separates the two.
    const reach = 1.5 * 2 * layout.radius * (1 + layout.gap);
    const reach2 = reach * reach;
    const corner = (from, to) => {
      let same = 0;
      let pairs = 0;
      for (let i = from; i < to; i++) {
        const xi = frames[base + 2 * i];
        const yi = frames[base + 2 * i + 1];
        for (let j = i + 1; j < to; j++) {
          const dx = frames[base + 2 * j] - xi;
          const dy = frames[base + 2 * j + 1] - yi;
          if (dx * dx + dy * dy > reach2) continue;
          pairs++;
          if (labels[i] === labels[j]) same++;
        }
      }
      return pairs ? same / pairs : 0.5;
    };
    const topLeft = Math.ceil(n / 2); // placeCorners puts these first
    const a = corner(0, topLeft);
    const b = corner(topLeft, n);
    return { topLeft: a, bottomRight: b, worst: Math.max(a, b) };
  }

  /*
   * What the opening frame looks like once the particles are labelled at the
   * sort time: { mix, clump }. mix is how sorted it is (0.5 is perfectly
   * mixed); clump is clumpiness() or null.
   *
   * Only simulates up to the sort time and only keeps two frames, but steps
   * frame by frame exactly as record() does. Rounding differs if you step
   * any other way, and in a chaotic gas that would lead to a different
   * trajectory, so this is what guarantees the answer matches the full run.
   */
  async function openingStats(state, opts) {
    const { sortTime, fps, split = 'even', onProgress, chunk = 30 } = opts;
    const n = state.n;
    const sortFrame = Math.max(0, Math.round(sortTime * fps));
    const sim = new Simulator(state);
    const frames = new Float32Array(2 * n * 2); // the opening frame, then the sort frame
    for (let f = 0; f <= sortFrame; f++) {
      sim.advanceTo(f / fps);
      for (const slot of [f === 0 ? 0 : -1, f === sortFrame ? 1 : -1]) {
        if (slot < 0) continue;
        const base = slot * n * 2;
        for (let i = 0; i < n; i++) {
          frames[base + 2 * i] = sim.x[i];
          frames[base + 2 * i + 1] = sim.y[i];
        }
      }
      if (onProgress && (f + 1) % chunk === 0) await onProgress(f + 1, sortFrame + 1);
    }
    const { labels, boundary } = labelFrame(frames, n * 2, n, state.width, split);
    return {
      mix: sortednessAt({ n, frames }, labels, boundary, 0),
      clump: clumpiness(frames, 0, n, labels, state),
    };
  }

  // Can this seed be used? Clumpiness only limits corner starts.
  function acceptable(stats, maxClump) {
    return maxClump == null || stats.clump == null || stats.clump.worst <= maxClump;
  }

  /*
   * Try each seed with otherwise identical settings and return the
   * acceptable one (clumpiness at most opts.maxClump, if given) whose
   * opening frame is closest to perfectly mixed: { seed, mix, clump }, or
   * null if none is acceptable. Ties go to the earlier seed. opts are as for
   * openingStats, plus onSeed(done, total, seed, stats), which may return a
   * promise.
   */
  async function findBestSeed(base, seeds, opts) {
    let best = null;
    for (let k = 0; k < seeds.length; k++) {
      const seed = seeds[k];
      const stats = await openingStats(createInitialState({ ...base, seed }), opts);
      if (acceptable(stats, opts.maxClump)) {
        if (!best || Math.abs(stats.mix - 0.5) < Math.abs(best.mix - 0.5)) best = { seed, ...stats };
      }
      if (opts.onSeed) await opts.onSeed(k + 1, seeds.length, seed, stats);
    }
    return best;
  }

  return {
    BLUE,
    RED,
    mulberry32,
    createInitialState,
    randomColours,
    Simulator,
    record,
    Replay,
    assignColours,
    sortedness,
    clumpiness,
    openingStats,
    acceptable,
    findBestSeed,
  };
});
