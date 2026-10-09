# Entropy Fakeout

A standard 2D hard-disk gas (elastic collisions, no damping) in which the
blue particles appear to gather on the left and the red particles on the
right at a chosen moment.

Open `index.html` in a browser. Nothing to install or build.

There are two versions, linked from each other's header:

- **Fake-out** (`index.html`): ordinary physics, with the colours assigned
  after the fact so the gas appears to sort itself.
- **One-way membrane** (`membrane.html`): a live simulation where a
  membrane down the middle lets blue through leftwards and red through
  rightwards, and really does sort the gas. See
  [One-way membrane](#one-way-membrane) below.

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

For slow motion, lower the RMS speed rather than the playback speed. A
hard-disk gas has no built-in timescale, so a gas at 75 px/s played at 1×
looks just like one at 300 px/s played at quarter speed, and every frame is
new, so it stays smooth. Scale the sort time and duration by the same
factor. A seed gives a different run at a different speed, so search for
seeds again after changing it.

### Corner start

Each cluster is a hexagonal lattice cut to a quarter disc around its corner,
so its size follows from the particle count and radius. Neighbouring
particles, and the outer particles and the walls, are separated by a gap
set as a percentage of the particle diameter (default 25%). If the two
clusters would meet in the middle, you get an error asking for fewer or
smaller particles.

Because colours come from positions at the sort time, each corner cluster
starts as a mix of blue and red.

### Finding a well-mixed seed

Some seeds start out looking more sorted than others. The seed search in
the page tries a number of seeds (your current one plus random others) with
all other settings unchanged, and keeps the one whose opening frame is
closest to 50% sorted. It stops early if a seed scores exactly 50%, since
nothing can beat that.

An even split overall can still hide clumps: the blue particles in a corner
cluster might sit on one side of it. With the corner start you can set a
maximum **clumpiness**, the share of touching neighbours in a cluster that
have the same colour (taking the worse of the two corners). A random mix
scores about 50%; colours in patches or on one side score higher. With the
default settings about half of all seeds score 52% or less, which is the
default limit. The search only considers seeds within the limit, and the
status under the settings shows the clumpiness of the current run.

Seeds run in parallel, one Web Worker per CPU core, each running the same
`sim.js` as the player. Each try only simulates up to the sort time, but it
steps frame by frame exactly as the full run does, so the full run
reproduces the mix it measured. From code: `Sim.findBestSeed(settings,
seeds, { sortTime, fps, split, maxClump })` (one core).

Why not Python or another language: the gas is chaotic, so a seed only
reproduces if the search and the player perform exactly the same
floating-point operations. A port would have to match JavaScript bit for
bit, including its `Math.log` and `Math.cos`. Running the player's own code
on every core is both exact and faster.

Settings are saved in the browser's local storage and restored on the next
visit. "Reset to defaults" restores the original values.

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

## One-way membrane

`membrane.html` starts with particles scattered at random over the box and
exactly half of them, chosen at random, coloured blue. A membrane at the
centre line lets blue particles cross only leftwards and red only
rightwards. The membrane acts on particle centres: a particle heading the
wrong way bounces back when its centre reaches the line, so half of it
pokes through first. (Equivalently, blue bounces off a wall one radius to
the right of the line, and red off one a radius to the left.) Everything
else is the same elastic physics as the fake-out. Nothing is simulated ahead: the page
runs the simulation as it plays, always in steps of 1/60 s of simulated
time, so a seed gives the same run whatever the display or playback speed.
With the default settings the gas is about 95% sorted after 20 to 30 s.
The membrane can be switched off mid-run to watch the gas mix again.

From code, pass a membrane to the simulator:

```js
const labels = Sim.randomColours(state.n, seed);
const sim = new Sim.Simulator({ ...state, membrane: { x: 480, labels } });
sim.setMembrane(false); // and back on with true
```

Without a membrane the simulator behaves exactly as before.

## Files

- `sim.js`: physics, recording and labelling. Works in the browser
  (`window.EntropySim`) and in Node (`require('./sim.js')`).
- `app.js`, `index.html`: the fake-out player.
- `membrane.js`, `membrane.html`: the one-way membrane page.
- `style.css`: styles shared by both pages.
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
