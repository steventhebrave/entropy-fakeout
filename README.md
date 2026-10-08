# Entropy Fakeout

A standard 2D hard-disk gas (elastic collisions, no damping) in which the
blue particles appear to gather on the left and the red particles on the
right at a chosen moment.

Open `index.html` in a browser. Nothing to install or build.

Keyboard: **Space** plays or pauses, **N** picks a new random seed and runs
it, and the arrow keys step through frames when the timeline has focus
(hold Shift for 1 s steps).

## How it works

1. **Simulate without colour.** Half the particles start packed into the
   top-left corner and half into the bottom-right (or, optionally, spread out
   at random). `sim.js` runs an event-driven hard-disk simulation. Each collision with another disk or a wall is elastic and is
   resolved at the exact moment it happens, with no time step. Particles
   never overlap and kinetic energy is conserved to rounding error (about
   1e-16 relative drift). Every frame (60 fps) is recorded.
2. **Label at the sort time.** At the sort-time frame, particles left of the
   dividing line become blue and the rest red.
3. **Play the recording back** with those labels. The gas looks mixed,
   sorts itself at the sort time, then mixes again.

### Why replay a recording instead of re-running?

The gas is chaotic: any difference in the 16th decimal place (a different
frame rate, time step or operation order) grows exponentially, and after a
few dozen collisions the trajectories are unrelated. Re-running only works
if the second run is bit-for-bit identical. Recording the first run and
replaying it guarantees that. It also makes scrubbing and changing the sort
time instant, because relabelling does not need a new simulation.

The same seed gives the same trajectories every time.

### Corner start

Each cluster is a hexagonal lattice cut to a quarter disc around its corner,
so its size follows from the particle count and radius. Neighbouring
particles, and the outer particles and the walls, are separated by a gap
set as a percentage of the particle diameter (default 25%). If the two
clusters would meet in the middle, you get an error asking for fewer or
smaller particles.

Because colours come from positions at the sort time, each corner cluster
starts as a mix of blue and red.

### Dividing line

- **Half each** (default): the leftmost half of the particles at the sort
  time become blue. Exactly half of each colour, sorted at exactly the
  requested time. The line falls midway between the two middle particles,
  near the centre but not exactly on it.
- **Exact centre**: split at the centre of the box. The two colours can
  differ in number by a few particles.

### Choosing the sort time

The gas mixes by diffusion, which is slow. If the sort time is too early,
the first frame still looks partly sorted and the trick shows. The
"sortedness" curve (share of particles on their own colour's side, 50% when
fully mixed) should start and end near 50%. With the defaults (200
particles, radius 6 px, RMS speed 300 px/s in a 960 × 540 box) it takes
about 15 s for the memory of the sorted state to fade. A denser or slower
gas needs a later sort time.

## Files

- `sim.js`: physics, recording and labelling. Works in the browser
  (`window.EntropySim`) and in Node (`require('./sim.js')`).
- `app.js`, `index.html`: the player.
- `test/sim.test.js`: run with `npm test` (Node 18+).

## Using it from code

```js
const Sim = require('./sim.js');

const initial = Sim.createInitialState({
  n: 200, radius: 6, speed: 300, seed: 1, width: 960, height: 540,
  start: 'corners', // or 'random'
  gap: 0.25, // corner clusters: gap between particles as a fraction of diameter
});
const rec = await Sim.record(initial, { duration: 30, fps: 60 });
const { labels } = Sim.assignColours(rec, 15); // 0 = blue, 1 = red

// Position of particle i in frame f:
//   x = rec.frames[(f * rec.n + i) * 2], y = rec.frames[(f * rec.n + i) * 2 + 1]
```
