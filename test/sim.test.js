'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../sim.js');

const BOX = { width: 960, height: 540 };

function makeState(overrides = {}) {
  return Sim.createInitialState({ n: 200, radius: 6, speed: 300, seed: 1, ...BOX, ...overrides });
}

test('a lone particle bounces off the walls exactly', () => {
  const state = {
    n: 1,
    radius: 10,
    ...BOX,
    x: Float64Array.of(100),
    y: Float64Array.of(270),
    vx: Float64Array.of(200),
    vy: Float64Array.of(0),
  };
  const sim = new Sim.Simulator(state);
  // Travel range is x = 10..950, so one round trip from x = 100 takes 9.4 s.
  sim.advanceTo(4);
  assert.equal(sim.wallCollisions, 0);
  sim.advanceTo(9.4);
  assert.ok(Math.abs(sim.x[0] - 100) < 1e-9, `x = ${sim.x[0]}`);
  assert.equal(sim.vx[0], 200);
  assert.equal(sim.wallCollisions, 2);
});

test('equal disks in a head-on collision swap velocities', () => {
  const state = {
    n: 2,
    radius: 10,
    ...BOX,
    x: Float64Array.of(400, 560),
    y: Float64Array.of(270, 270),
    vx: Float64Array.of(50, -30),
    vy: Float64Array.of(0, 0),
  };
  const sim = new Sim.Simulator(state);
  sim.advanceTo(1.5); // they touch at t = 140 / 80 = 1.75 s
  assert.equal(sim.particleCollisions, 0);
  sim.advanceTo(2);
  assert.equal(sim.particleCollisions, 1);
  assert.ok(Math.abs(sim.vx[0] + 30) < 1e-9 && Math.abs(sim.vx[1] - 50) < 1e-9);
});

test('initial state has no overlaps, zero momentum and the requested RMS speed', () => {
  const s = makeState();
  let px = 0;
  let py = 0;
  let sumSq = 0;
  for (let i = 0; i < s.n; i++) {
    px += s.vx[i];
    py += s.vy[i];
    sumSq += s.vx[i] ** 2 + s.vy[i] ** 2;
    for (let j = i + 1; j < s.n; j++) {
      assert.ok(Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]) >= 2 * s.radius);
    }
  }
  assert.ok(Math.abs(px) < 1e-9 && Math.abs(py) < 1e-9);
  assert.ok(Math.abs(Math.sqrt(sumSq / s.n) - 300) < 1e-9);
});

test('recording conserves energy and never overlaps or leaves the box', async () => {
  const rec = await Sim.record(makeState(), { duration: 20, fps: 60 });
  const drift = Math.abs(rec.energyEnd - rec.energyStart) / rec.energyStart;
  assert.ok(drift < 1e-9, `energy drift ${drift}`);
  assert.ok(rec.particleCollisions > 1000, `only ${rec.particleCollisions} collisions`);

  const { n, radius, frames, frameCount, width, height } = rec;
  const tol = 1e-3; // frames are stored as float32
  const minD2 = (2 * radius - tol) ** 2;
  for (let f = 0; f < frameCount; f++) {
    const base = f * n * 2;
    for (let i = 0; i < n; i++) {
      const xi = frames[base + 2 * i];
      const yi = frames[base + 2 * i + 1];
      assert.ok(xi >= radius - tol && xi <= width - radius + tol, `x out of box at frame ${f}`);
      assert.ok(yi >= radius - tol && yi <= height - radius + tol, `y out of box at frame ${f}`);
      for (let j = i + 1; j < n; j++) {
        const dx = frames[base + 2 * j] - xi;
        const dy = frames[base + 2 * j + 1] - yi;
        assert.ok(dx * dx + dy * dy >= minD2, `overlap of ${i} and ${j} at frame ${f}`);
      }
    }
  }
});

test('corner start packs half the particles into each opposite corner with even gaps', () => {
  for (const [n, radius, gap] of [[200, 6, 0.25], [61, 9, 0.1], [1000, 4, 0.25]]) {
    const s = makeState({ n, radius, gap });
    const pitch = 2 * radius * (1 + gap);
    const margin = radius * (1 + 2 * gap);
    const topLeft = Math.ceil(n / 2);
    for (let i = 0; i < n; i++) {
      const inTopLeft = s.x[i] < s.width / 2 && s.y[i] < s.height / 2;
      const inBottomRight = s.x[i] > s.width / 2 && s.y[i] > s.height / 2;
      assert.ok(i < topLeft ? inTopLeft : inBottomRight, `particle ${i} is in the wrong corner`);
      assert.ok(s.x[i] >= margin - 1e-9 && s.x[i] <= s.width - margin + 1e-9);
      assert.ok(s.y[i] >= margin - 1e-9 && s.y[i] <= s.height - margin + 1e-9);
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]);
        assert.ok(d >= pitch - 1e-9, `particles ${i} and ${j} are ${d} apart, want ${pitch}`);
      }
    }
  }
});

test('corner start refuses clusters that would meet in the middle', () => {
  assert.throws(() => makeState({ n: 1000, radius: 14 }), /do not fit in two corner clusters/);
});

test('the same seed gives bit-identical trajectories', async () => {
  const a = await Sim.record(makeState({ seed: 7 }), { duration: 5, fps: 60 });
  const b = await Sim.record(makeState({ seed: 7 }), { duration: 5, fps: 60 });
  assert.deepEqual(a.frames, b.frames);
});

for (const split of ['even', 'centre']) {
  test(`'${split}' labels sort the gas exactly at the sort time and not at the ends`, async () => {
    const rec = await Sim.record(makeState({ start: 'random' }), { duration: 30, fps: 60 });
    const { labels, frame, time, boundary } = Sim.assignColours(rec, 15, split);
    assert.equal(frame, 900);
    assert.equal(time, 15);

    const blues = labels.filter((l) => l === Sim.BLUE).length;
    if (split === 'even') assert.equal(blues, rec.n / 2);
    else assert.equal(boundary, rec.width / 2);
    assert.ok(Math.abs(boundary - rec.width / 2) < rec.width * 0.1, `boundary at ${boundary}`);

    const base = frame * rec.n * 2;
    for (let i = 0; i < rec.n; i++) {
      const left = rec.frames[base + 2 * i] < boundary;
      assert.equal(left, labels[i] === Sim.BLUE, `particle ${i} on the wrong side`);
    }

    const order = Sim.sortedness(rec, labels, boundary);
    assert.equal(order[frame], 1);
    assert.ok(order[0] < 0.6, `start already looks sorted: ${order[0]}`);
    assert.ok(order[rec.frameCount - 1] < 0.6, `end still looks sorted: ${order[rec.frameCount - 1]}`);
  });
}

test('seed search reports the opening mix that the full run shows', async () => {
  const base = { n: 120, radius: 6, speed: 300, width: 960, height: 540 };
  const opts = { sortTime: 4.01, fps: 60, split: 'even' };
  const seen = [];
  const best = await Sim.findBestSeed(base, [3, 4, 5, 6], {
    ...opts,
    onSeed: (done, total, seed, stats) => seen.push({ seed, ...stats }),
  });
  assert.equal(seen.length, 4);
  const closest = Math.min(...seen.map((r) => Math.abs(r.mix - 0.5)));
  assert.equal(Math.abs(best.mix - 0.5), closest);

  // A full-length recording of each seed agrees with what the search saw.
  for (const { seed, mix, clump } of seen) {
    const rec = await Sim.record(Sim.createInitialState({ ...base, seed }), { duration: 6, fps: 60 });
    const { labels, boundary } = Sim.assignColours(rec, opts.sortTime, opts.split);
    assert.equal(Sim.sortedness(rec, labels, boundary)[0], Math.fround(mix), `seed ${seed}`);
    assert.deepEqual(Sim.clumpiness(rec.frames, 0, rec.n, labels, rec), clump, `seed ${seed}`);
  }
});

test('seed search skips seeds above the clumpiness limit', async () => {
  const base = { n: 120, radius: 6, speed: 300, width: 960, height: 540 };
  const opts = { sortTime: 4, fps: 60 };
  const seen = [];
  await Sim.findBestSeed(base, [3, 4, 5, 6, 7, 8], {
    ...opts,
    onSeed: (done, total, seed, stats) => seen.push({ seed, ...stats }),
  });
  const limit = [...seen].sort((a, b) => a.clump.worst - b.clump.worst)[2].clump.worst;
  const allowed = seen.filter((r) => r.clump.worst <= limit);
  const want = allowed.reduce((a, b) => (Math.abs(b.mix - 0.5) < Math.abs(a.mix - 0.5) ? b : a));
  const best = await Sim.findBestSeed(base, [3, 4, 5, 6, 7, 8], { ...opts, maxClump: limit });
  assert.equal(best.seed, want.seed);
  assert.equal(await Sim.findBestSeed(base, [3, 4], { ...opts, maxClump: -1 }), null);
});

test('clumpiness tells a random mix from colours grouped on one side', () => {
  const s = Sim.createInitialState({ n: 200, radius: 6, speed: 300, seed: 1, width: 960, height: 540 });
  const frames = new Float32Array(s.n * 2);
  for (let i = 0; i < s.n; i++) {
    frames[2 * i] = s.x[i];
    frames[2 * i + 1] = s.y[i];
  }
  // Blue on the left of each cluster, red on the right.
  const order = (from, to) => Array.from({ length: to - from }, (_, k) => from + k).sort((a, b) => s.x[a] - s.x[b]);
  const sided = new Uint8Array(s.n);
  for (const [from, to] of [[0, 100], [100, 200]]) {
    order(from, to).forEach((i, rank) => {
      sided[i] = rank < 50 ? Sim.BLUE : Sim.RED;
    });
  }
  assert.ok(Sim.clumpiness(frames, 0, s.n, sided, s).worst > 0.8);

  // Random colours average close to 0.5.
  const rand = Sim.mulberry32(9);
  let total = 0;
  for (let k = 0; k < 50; k++) {
    const labels = Uint8Array.from({ length: s.n }, () => (rand() < 0.5 ? Sim.BLUE : Sim.RED));
    const c = Sim.clumpiness(frames, 0, s.n, labels, s);
    total += (c.topLeft + c.bottomRight) / 2;
  }
  assert.ok(Math.abs(total / 50 - 0.5) < 0.02, `random mix scored ${total / 50}`);

  assert.equal(Sim.clumpiness(frames, 0, s.n, sided, { ...s, start: 'random' }), null);
});

function oneParticle(label, x, vx) {
  return {
    n: 1,
    radius: 10,
    ...BOX,
    x: Float64Array.of(x),
    y: Float64Array.of(270),
    vx: Float64Array.of(vx),
    vy: Float64Array.of(0),
    membrane: { x: 480, labels: Uint8Array.of(label) },
  };
}

test('membrane lets blue through leftwards only', () => {
  // Blue starting right of the membrane, moving left: passes straight through.
  const sim = new Sim.Simulator(oneParticle(Sim.BLUE, 700, -200));
  sim.advanceTo(2); // x = 300
  assert.equal(sim.membraneBounces, 0);
  assert.ok(Math.abs(sim.x[0] - 300) < 1e-9);
  // Left wall (x = 10) at 3.45 s, then back towards the membrane, bouncing
  // when its edge touches it (x = 470) at 5.75 s, so by 6 s it is at 420.
  sim.advanceTo(6);
  assert.equal(sim.membraneBounces, 1);
  assert.ok(sim.vx[0] < 0 && Math.abs(sim.x[0] - 420) < 1e-9, `x = ${sim.x[0]}`);
});

test('membrane lets red through rightwards only', () => {
  const sim = new Sim.Simulator(oneParticle(Sim.RED, 260, 200));
  sim.advanceTo(2); // x = 660, passed through
  assert.equal(sim.membraneBounces, 0);
  // Right wall (x = 950) at 3.45 s, then back, bouncing at x = 490 at 5.75 s.
  sim.advanceTo(6);
  assert.equal(sim.membraneBounces, 1);
  assert.ok(sim.vx[0] > 0 && Math.abs(sim.x[0] - 540) < 1e-9, `x = ${sim.x[0]}`);
});

test('a membrane sorts a random gas, conserving energy without overlaps', () => {
  const s = Sim.createInitialState({ n: 200, radius: 6, speed: 300, seed: 3, start: 'random', ...BOX });
  const labels = Sim.randomColours(s.n, 3);
  assert.equal(labels.filter((l) => l === Sim.BLUE).length, 100);
  const sim = new Sim.Simulator({ ...s, membrane: { x: BOX.width / 2, labels } });
  const sorted = () => {
    let good = 0;
    for (let i = 0; i < s.n; i++) if ((sim.x[i] < BOX.width / 2) === (labels[i] === Sim.BLUE)) good++;
    return good / s.n;
  };
  const e0 = sim.kineticEnergy();
  assert.ok(sorted() < 0.65);
  for (let t = 1; t <= 120; t++) {
    sim.advanceTo(t);
    for (let i = 0; i < s.n; i++) {
      for (let j = i + 1; j < s.n; j++) {
        const d = Math.hypot(sim.x[i] - sim.x[j], sim.y[i] - sim.y[j]);
        assert.ok(d >= 2 * s.radius - 1e-6, `overlap at ${t} s`);
      }
    }
  }
  assert.ok(sorted() > 0.97, `only ${sorted()} sorted after 120 s`);
  assert.ok(sim.membraneBounces > 100);
  assert.ok(Math.abs(sim.kineticEnergy() - e0) / e0 < 1e-9);
});

test('switching the membrane off stops the sorting', () => {
  const s = Sim.createInitialState({ n: 100, radius: 6, speed: 300, seed: 4, start: 'random', ...BOX });
  const labels = Sim.randomColours(s.n, 4);
  const sim = new Sim.Simulator({ ...s, membrane: { x: BOX.width / 2, labels } });
  sim.advanceTo(5);
  const bounces = sim.membraneBounces;
  sim.setMembrane(false);
  sim.advanceTo(30);
  assert.equal(sim.membraneBounces, bounces);
  sim.setMembrane(true);
  sim.advanceTo(40);
  assert.ok(sim.membraneBounces > bounces);
});
