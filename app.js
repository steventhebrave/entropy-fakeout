/* Entropy Fakeout: browser player. Runs the simulation, labels it, plays it back. */
(function () {
  'use strict';

  const Sim = window.EntropySim;
  const BOX = { width: 960, height: 540 };
  const FPS = 60;
  const MAX_STEP = 0.1; // longest real-time jump per animation frame, in seconds

  const $ = (id) => document.getElementById(id);
  const el = {
    box: $('box'),
    timeline: $('timeline'),
    play: $('play'),
    playLabel: $('play-label'),
    iconPlay: $('icon-play'),
    iconPause: $('icon-pause'),
    restart: $('restart'),
    time: $('time-readout'),
    order: $('order-readout'),
    rate: $('rate'),
    loop: $('loop'),
    form: $('settings'),
    run: $('run'),
    pending: $('pending'),
    status: $('status'),
    start: $('start'),
    gap: $('gap'),
    n: $('n'),
    radius: $('radius'),
    speed: $('speed'),
    duration: $('duration'),
    seed: $('seed'),
    reseed: $('reseed'),
    sortTime: $('sort-time'),
    split: $('split'),
    colour: $('colour'),
    showLine: $('show-line'),
  };

  const state = {
    rec: null, // recorded trajectories
    sort: null, // { labels, frame, time, split, boundary }
    order: null, // sortedness per frame
    frame: 0,
    playTime: 0,
    playing: false,
    lastTs: 0,
    run: 0, // increments per simulation so a stale run can be abandoned
    ranWith: null, // physics settings of the current recording
    statsText: '',
    resumeAfterRun: false, // set by the N shortcut so playback carries on
    colours: {},
  };

  // ---------- settings ----------

  function num(input, fallback, min, max) {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  function physicsSettings() {
    let n = Math.round(num(el.n, 200, 2, 1000));
    if (n % 2) n -= 1;
    return {
      start: el.start.value,
      gap: num(el.gap, 25, 0, 200) / 100,
      n,
      radius: num(el.radius, 6, 1, 40),
      speed: num(el.speed, 300, 10, 2000),
      duration: num(el.duration, 30, 1, 120),
      seed: Math.round(num(el.seed, 1, 0, 4294967295)),
    };
  }

  function updatePending() {
    if (!state.ranWith) return;
    const now = physicsSettings();
    el.pending.hidden = Object.keys(now).every((k) => now[k] === state.ranWith[k]);
  }

  // ---------- drawing ----------

  function readColours() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['box', 'ink', 'muted', 'line', 'blue', 'red', 'grey']) {
      state.colours[k] = cs.getPropertyValue('--' + k).trim();
    }
    state.colours.font = `11px ${cs.getPropertyValue('--font-data').trim() || 'monospace'}`;
  }

  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  function drawBox() {
    const canvas = el.box;
    const ctx = canvas.getContext('2d');
    const dpr = fitCanvas(canvas);
    const c = state.colours;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c.box;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const rec = state.rec;
    if (!rec) return;

    const s = canvas.width / rec.width;
    ctx.setTransform(s, 0, 0, s, 0, 0);

    if (el.showLine.checked && state.sort) {
      ctx.save();
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = (1.5 * dpr) / s;
      ctx.setLineDash([(6 * dpr) / s, (6 * dpr) / s]);
      ctx.beginPath();
      ctx.moveTo(state.sort.boundary, 0);
      ctx.lineTo(state.sort.boundary, rec.height);
      ctx.stroke();
      ctx.restore();
    }

    const { n, radius: r, frames } = rec;
    const base = state.frame * n * 2;
    const coloured = el.colour.checked && state.sort;
    const groups = coloured
      ? [
          [Sim.BLUE, c.blue],
          [Sim.RED, c.red],
        ]
      : [[-1, c.grey]];
    for (const [label, colour] of groups) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if (label >= 0 && state.sort.labels[i] !== label) continue;
        const x = frames[base + 2 * i];
        const y = frames[base + 2 * i + 1];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fillStyle = colour;
      ctx.fill();
    }
  }

  // Timeline geometry in CSS pixels.
  const TL = { left: 46, right: 12, top: 10, bottom: 22 };

  function timelineX(canvasCssWidth, f) {
    const span = Math.max(1, state.rec.frameCount - 1);
    return TL.left + (f / span) * (canvasCssWidth - TL.left - TL.right);
  }

  function drawTimeline() {
    const canvas = el.timeline;
    const ctx = canvas.getContext('2d');
    const dpr = fitCanvas(canvas);
    const c = state.colours;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotBottom = h - TL.bottom;
    const plotH = plotBottom - TL.top;
    const yOf = (v) => plotBottom - Math.max(0, Math.min(1, (v - 0.5) / 0.5)) * plotH;

    ctx.font = c.font;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    for (const v of [0.5, 0.75, 1]) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(TL.left, y);
      ctx.lineTo(w - TL.right, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(v * 100)}%`, TL.left - 8, y);
    }

    const rec = state.rec;
    if (!rec || !state.order) return;
    const frames = rec.frameCount;
    const duration = (frames - 1) / rec.fps;

    // Time ticks
    const steps = [1, 2, 5, 10, 15, 20, 30, 60];
    const plotW = w - TL.left - TL.right;
    const step = steps.find((s) => (duration / s) * 44 <= plotW) || 60;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let t = 0; t <= duration + 1e-9; t += step) {
      const x = timelineX(w, t * rec.fps);
      ctx.fillText(String(t), x, h - 6);
    }

    // Sortedness curve, one sample per CSS pixel
    const order = state.order;
    ctx.beginPath();
    ctx.moveTo(TL.left, plotBottom);
    for (let px = 0; px <= plotW; px++) {
      const f = Math.round((px / plotW) * (frames - 1));
      ctx.lineTo(TL.left + px, yOf(order[f]));
    }
    ctx.lineTo(TL.left + plotW, plotBottom);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = c.ink;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    for (let px = 0; px <= plotW; px++) {
      const f = Math.round((px / plotW) * (frames - 1));
      const y = yOf(order[f]);
      if (px === 0) ctx.moveTo(TL.left, y);
      else ctx.lineTo(TL.left + px, y);
    }
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // Sort time marker
    const sx = Math.round(timelineX(w, state.sort.frame)) + 0.5;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = c.muted;
    ctx.beginPath();
    ctx.moveTo(sx, TL.top);
    ctx.lineTo(sx, plotBottom);
    ctx.stroke();
    ctx.restore();

    // Playhead
    const px = timelineX(w, state.frame);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, TL.top - 4);
    ctx.lineTo(px, plotBottom);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, yOf(order[state.frame]), 4, 0, 2 * Math.PI);
    ctx.fillStyle = c.ink;
    ctx.fill();
  }

  function updateReadouts() {
    const rec = state.rec;
    if (!rec) return;
    const t = state.frame / rec.fps;
    el.time.textContent = `${t.toFixed(2)} s`;
    el.order.textContent = state.order ? `${Math.round(state.order[state.frame] * 100)}%` : '–';
    el.timeline.setAttribute('aria-valuenow', String(state.frame));
    el.timeline.setAttribute('aria-valuetext', `${t.toFixed(2)} seconds`);
  }

  function render() {
    drawBox();
    drawTimeline();
    updateReadouts();
  }

  // ---------- playback ----------

  function lastTime() {
    return state.rec ? (state.rec.frameCount - 1) / state.rec.fps : 0;
  }

  function seek(time) {
    if (!state.rec) return;
    state.playTime = Math.max(0, Math.min(lastTime(), time));
    state.frame = Math.round(state.playTime * state.rec.fps);
    render();
  }

  function setPlaying(on) {
    state.playing = on && !!state.rec;
    el.iconPlay.hidden = state.playing;
    el.iconPause.hidden = !state.playing;
    el.playLabel.textContent = state.playing ? 'Pause' : 'Play';
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    if (state.playing) {
      if (state.playTime >= lastTime()) state.playTime = 0;
      state.lastTs = 0;
      requestAnimationFrame(tick);
    }
  }

  function tick(ts) {
    if (!state.playing) return;
    const dt = state.lastTs ? Math.min(MAX_STEP, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;
    let t = state.playTime + dt * parseFloat(el.rate.value);
    if (t >= lastTime()) {
      if (el.loop.checked) t = 0;
      else {
        seek(lastTime());
        setPlaying(false);
        return;
      }
    }
    seek(t);
    requestAnimationFrame(tick);
  }

  // ---------- simulation and labels ----------

  function relabel() {
    const rec = state.rec;
    if (!rec) return;
    const sortTime = num(el.sortTime, 15, 0, lastTime());
    state.sort = Sim.assignColours(rec, sortTime, el.split.value);
    state.order = Sim.sortedness(rec, state.sort.labels, state.sort.boundary);
    showStatus();
    render();
  }

  function showStatus(error) {
    el.status.replaceChildren();
    if (error) {
      const p = document.createElement('p');
      p.className = 'error';
      p.setAttribute('role', 'alert');
      p.textContent = error;
      el.status.append(p);
    }
    if (state.statsText) {
      const p = document.createElement('p');
      p.textContent = state.statsText;
      el.status.append(p);
    }
    if (state.sort) {
      const { labels, time, boundary, split } = state.sort;
      const blues = labels.reduce((a, l) => a + (l === Sim.BLUE ? 1 : 0), 0);
      const p = document.createElement('p');
      p.textContent =
        `Sorted at ${time.toFixed(2)} s · ${blues} blue, ${labels.length - blues} red · ` +
        (split === 'centre'
          ? 'line at the centre'
          : `line at x = ${boundary.toFixed(1)} (centre is ${state.rec.width / 2})`);
      el.status.append(p);
    }
  }

  async function runSimulation() {
    const run = ++state.run;
    const settings = physicsSettings();
    el.n.value = settings.n;
    setPlaying(false);
    el.run.disabled = true;
    el.run.textContent = 'Simulating…';

    let initial;
    try {
      initial = Sim.createInitialState({ ...settings, ...BOX });
    } catch (err) {
      el.run.disabled = false;
      el.run.textContent = 'Run simulation';
      showStatus(err.message);
      return;
    }

    const started = performance.now();
    let rec;
    try {
      rec = await Sim.record(initial, {
        duration: settings.duration,
        fps: FPS,
        chunk: Math.max(2, Math.round(6000 / settings.n)),
        onProgress: (done, total) => {
          if (run !== state.run) throw new Error('superseded');
          el.run.textContent = `Simulating… ${Math.floor((100 * done) / total)}%`;
          return new Promise((resolve) => setTimeout(resolve, 0));
        },
      });
    } catch (err) {
      if (run !== state.run) return; // a newer run took over
      throw err;
    }
    if (run !== state.run) return;
    const seconds = (performance.now() - started) / 1000;

    state.rec = rec;
    state.ranWith = settings;
    const drift = Math.abs(rec.energyEnd - rec.energyStart) / rec.energyStart;
    state.statsText =
      `${rec.n} particles · ${settings.duration} s · ` +
      `${rec.particleCollisions.toLocaleString()} collisions · ` +
      `computed in ${seconds.toFixed(1)} s · energy drift ${drift.toExponential(0)}`;
    el.timeline.setAttribute('aria-valuemax', String(rec.frameCount - 1));
    el.sortTime.max = String(settings.duration);
    el.run.disabled = false;
    el.run.textContent = 'Run simulation';
    updatePending();
    state.playTime = 0;
    state.frame = 0;
    relabel();
    return true;
  }

  // ---------- events ----------

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSimulation();
  });
  for (const input of [el.gap, el.n, el.radius, el.speed, el.duration, el.seed]) {
    input.addEventListener('input', updatePending);
  }
  const syncStart = () => {
    el.gap.disabled = el.start.value !== 'corners';
  };
  el.start.addEventListener('change', () => {
    syncStart();
    updatePending();
  });
  syncStart();
  el.reseed.addEventListener('click', () => {
    el.seed.value = String(Math.floor(Math.random() * 1e6));
    updatePending();
  });
  el.sortTime.addEventListener('input', relabel);
  el.split.addEventListener('change', relabel);
  el.colour.addEventListener('change', render);
  el.showLine.addEventListener('change', render);

  el.play.addEventListener('click', () => setPlaying(!state.playing));
  el.restart.addEventListener('click', () => seek(0));

  // Scrubbing on the timeline
  function seekFromPointer(e) {
    if (!state.rec) return;
    const rect = el.timeline.getBoundingClientRect();
    const plotW = rect.width - TL.left - TL.right;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - TL.left) / plotW));
    seek(frac * lastTime());
  }
  el.timeline.addEventListener('pointerdown', (e) => {
    el.timeline.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  });
  el.timeline.addEventListener('pointermove', (e) => {
    if (el.timeline.hasPointerCapture(e.pointerId)) seekFromPointer(e);
  });
  el.timeline.addEventListener('keydown', (e) => {
    if (!state.rec) return;
    const frame = 1 / state.rec.fps;
    const step = e.shiftKey ? 1 : frame;
    const moves = {
      ArrowLeft: state.playTime - step,
      ArrowRight: state.playTime + step,
      Home: 0,
      End: lastTime(),
    };
    if (e.key in moves) {
      e.preventDefault();
      seek(moves[e.key]);
    }
  });

  // Space: play/pause. N: new random seed and run it straight away.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea')) return;
    if (e.key === ' ' && !e.target.closest('button')) {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      state.resumeAfterRun = state.resumeAfterRun || state.playing;
      el.reseed.click();
      runSimulation().then((done) => {
        if (!done) return;
        if (state.resumeAfterRun) setPlaying(true);
        state.resumeAfterRun = false;
      });
    }
  });

  // Theme changes: re-read the colour tokens.
  const refreshTheme = () => {
    readColours();
    render();
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshTheme);
  new MutationObserver(refreshTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });
  new ResizeObserver(render).observe(el.box);
  if (document.fonts) document.fonts.ready.then(render);

  // ---------- start ----------

  readColours();
  render();
  runSimulation().then(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && state.rec) setPlaying(true);
  });
})();
