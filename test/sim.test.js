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
    onSeed: (done, total, seed, mix) => seen.push({ seed, mix }),
  });
  assert.equal(seen.length, 4);
  const closest = Math.min(...seen.map((r) => Math.abs(r.mix - 0.5)));
  assert.equal(Math.abs(best.mix - 0.5), closest);

  // A full-length recording of each seed agrees with what the search saw.
  for (const { seed, mix } of seen) {
    const rec = await Sim.record(Sim.createInitialState({ ...base, seed }), { duration: 6, fps: 60 });
    const { labels, boundary } = Sim.assignColours(rec, opts.sortTime, opts.split);
    assert.equal(Sim.sortedness(rec, labels, boundary)[0], Math.fround(mix), `seed ${seed}`);
  }
});
