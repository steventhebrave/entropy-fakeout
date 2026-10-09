/* One-Way Membrane: a live gas sorted by a membrane that lets blue through
   leftwards and red through rightwards. Shares its physics with the fake-out. */
(function () {
  'use strict';

  const Sim = window.EntropySim;
  const BOX = { width: 960, height: 540 };
  const MEMBRANE_X = BOX.width / 2;
  const FPS = 60; // the simulation always steps in 1/60 s, whatever the display does
  const SAMPLE_EVERY = 6; // frames between sortedness samples (0.1 s)
  const MAX_STEP = 0.1; // longest real-time jump per animation frame, in seconds
  const MIN_SPAN = 60; // the timeline shows at least this many seconds

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
    membraneOn: $('membrane-on'),
    showMembrane: $('show-membrane'),
    form: $('settings'),
    pending: $('pending'),
    status: $('status'),
    n: $('n'),
    radius: $('radius'),
    speed: $('speed'),
    seed: $('seed'),
    reseed: $('reseed'),
    reset: $('reset'),
  };

  const state = {
    sim: null,
    labels: null,
    frame: 0, // simulation frame shown
    clock: 0, // playback time in seconds; the simulation catches up to it
    history: [], // sortedness every SAMPLE_EVERY frames
    playing: false,
    lastTs: 0,
    ranWith: null,
    error: '',
    energyStart: 0,
    lastStatus: 0,
    colours: {},
  };

  // ---------- settings ----------

  function num(input, fallback, min, max) {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
  }

  function gasSettings() {
    let n = Math.round(num(el.n, 200, 2, 1000));
    if (n % 2) n -= 1;
    return {
      n,
      radius: num(el.radius, 6, 1, 40),
      speed: num(el.speed, 300, 10, 2000),
      seed: Math.round(num(el.seed, 1, 0, 4294967295)),
    };
  }

  function updatePending() {
    if (!state.ranWith) return;
    const now = gasSettings();
    el.pending.hidden = Object.keys(now).every((k) => now[k] === state.ranWith[k]);
  }

  // Remembered in this browser between visits, separately from the fake-out.
  const STORAGE_KEY = 'entropy-fakeout:membrane';
  const SAVED = ['n', 'radius', 'speed', 'seed', 'rate', 'membrane-on', 'show-membrane'];

  function saveSettings() {
    const data = {};
    for (const id of SAVED) {
      const input = $(id);
      data[id] = input.type === 'checkbox' ? input.checked : input.value;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (_) {
      // Storage is unavailable (private window, blocked site data): nothing to keep.
    }
  }

  function loadSettings() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
      return;
    }
    if (!data || typeof data !== 'object') return;
    for (const id of SAVED) {
      if (!(id in data)) continue;
      const input = $(id);
      const value = data[id];
      if (input.type === 'checkbox') input.checked = value === true;
      else if (input.tagName === 'SELECT') {
        if ([...input.options].some((o) => o.value === value)) input.value = value;
      } else if (typeof value === 'string') input.value = value;
    }
  }

  // Back to the page's built-in values. The restart saves them over the old ones.
  function resetSettings() {
    for (const id of SAVED) {
      const input = $(id);
      if (input.type === 'checkbox') input.checked = input.defaultChecked;
      else if (input.tagName === 'SELECT') {
        input.value = ([...input.options].find((o) => o.defaultSelected) || input.options[0]).value;
      } else input.value = input.defaultValue;
    }
    restart();
  }

  // ---------- simulation ----------

  function restart() {
    const settings = gasSettings();
    el.n.value = settings.n;
    saveSettings();
    let initial;
    try {
      initial = Sim.createInitialState({ ...settings, ...BOX, start: 'random' });
    } catch (err) {
      state.error = err.message;
      showStatus();
      return;
    }
    state.error = '';
    state.labels = Sim.randomColours(settings.n, settings.seed);
    state.sim = new Sim.Simulator({
      ...initial,
      membrane: { x: MEMBRANE_X, labels: state.labels, on: el.membraneOn.checked },
    });
    state.energyStart = state.sim.kineticEnergy();
    state.frame = 0;
    state.clock = 0;
    state.history = [sortedness()];
    state.ranWith = settings;
    updatePending();
    showStatus();
    render();
  }

  // Share of particles on their own colour's side: blue left, red right.
  function sortedness() {
    const { sim, labels } = state;
    let good = 0;
    for (let i = 0; i < sim.n; i++) {
      if ((sim.x[i] < MEMBRANE_X) === (labels[i] === Sim.BLUE)) good++;
    }
    return good / sim.n;
  }

  // Step the simulation in whole frames until it reaches the playback clock.
  function catchUp() {
    const { sim } = state;
    while ((state.frame + 1) / FPS <= state.clock) {
      state.frame++;
      sim.advanceTo(state.frame / FPS);
      if (state.frame % SAMPLE_EVERY === 0) state.history.push(sortedness());
    }
  }

  // ---------- drawing ----------

  function readColours() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['box', 'ink', 'muted', 'line', 'blue', 'red']) {
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

  // A dashed line: dark while the membrane works, faint while it is off.
  function drawMembrane(ctx, s, dpr) {
    if (!el.showMembrane.checked) return;
    const c = state.colours;
    const px = dpr / s; // one CSS pixel in world units
    ctx.save();
    ctx.strokeStyle = el.membraneOn.checked ? c.ink : c.line;
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([8 * px, 6 * px]);
    ctx.beginPath();
    ctx.moveTo(MEMBRANE_X, 0);
    ctx.lineTo(MEMBRANE_X, BOX.height);
    ctx.stroke();
    ctx.restore();
  }

  function drawBox() {
    const canvas = el.box;
    const ctx = canvas.getContext('2d');
    const dpr = fitCanvas(canvas);
    const c = state.colours;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = c.box;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = canvas.width / BOX.width;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    drawMembrane(ctx, s, dpr);
    const { labels } = state;
    if (!state.sim) return;
    // The simulation itself only steps in whole frames. Draw a throwaway copy
    // advanced to the exact playback time, so slow motion stays smooth.
    let sim = state.sim;
    if (state.clock > state.frame / FPS) {
      sim = sim.clone();
      sim.advanceTo(state.clock);
    }
    const r = sim.r;
    for (const [label, colour] of [
      [Sim.BLUE, c.blue],
      [Sim.RED, c.red],
    ]) {
      ctx.beginPath();
      for (let i = 0; i < sim.n; i++) {
        if (labels[i] !== label) continue;
        ctx.moveTo(sim.x[i] + r, sim.y[i]);
        ctx.arc(sim.x[i], sim.y[i], r, 0, 2 * Math.PI);
      }
      ctx.fillStyle = colour;
      ctx.fill();
    }
  }

  const TL = { left: 46, right: 12, top: 10, bottom: 22 };

  function drawTimeline() {
    const canvas = el.timeline;
    const ctx = canvas.getContext('2d');
    const dpr = fitCanvas(canvas);
    const c = state.colours;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const plotW = w - TL.left - TL.right;
    const plotBottom = h - TL.bottom;
    const plotH = plotBottom - TL.top;
    const yOf = (v) => plotBottom - Math.max(0, Math.min(1, (v - 0.5) / 0.5)) * plotH;
    const span = Math.max(MIN_SPAN, state.frame / FPS);
    const xOf = (t) => TL.left + (t / span) * plotW;

    ctx.font = c.font;
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of [0.5, 0.75, 1]) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(TL.left, y);
      ctx.lineTo(w - TL.right, y);
      ctx.stroke();
      ctx.fillText(`${Math.round(v * 100)}%`, TL.left - 8, y);
    }
    const steps = [5, 10, 15, 20, 30, 60, 120, 300, 600, 1200];
    const step = steps.find((s) => (span / s) * 44 <= plotW) || 3600;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let t = 0; t <= span + 1e-9; t += step) ctx.fillText(String(t), xOf(t), h - 6);

    const hist = state.history;
    if (hist.length < 2) return;
    const dt = SAMPLE_EVERY / FPS;
    ctx.beginPath();
    ctx.moveTo(xOf(0), plotBottom);
    hist.forEach((v, k) => ctx.lineTo(xOf(k * dt), yOf(v)));
    ctx.lineTo(xOf((hist.length - 1) * dt), plotBottom);
    ctx.closePath();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = c.ink;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    hist.forEach((v, k) => (k ? ctx.lineTo(xOf(k * dt), yOf(v)) : ctx.moveTo(xOf(0), yOf(v))));
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.25;
    ctx.stroke();

    const last = hist.length - 1;
    ctx.beginPath();
    ctx.arc(xOf(last * dt), yOf(hist[last]), 4, 0, 2 * Math.PI);
    ctx.fillStyle = c.ink;
    ctx.fill();
  }

  function updateReadouts() {
    if (!state.sim) return;
    el.time.textContent = `${(state.frame / FPS).toFixed(2)} s`;
    el.order.textContent = `${Math.round(sortedness() * 100)}%`;
  }

  function showStatus() {
    el.status.replaceChildren();
    if (state.error) {
      const p = document.createElement('p');
      p.className = 'error';
      p.setAttribute('role', 'alert');
      p.textContent = state.error;
      el.status.append(p);
      return;
    }
    const { sim, labels } = state;
    if (!sim) return;
    let blueLeft = 0;
    let redRight = 0;
    let blues = 0;
    for (let i = 0; i < sim.n; i++) {
      if (labels[i] === Sim.BLUE) {
        blues++;
        if (sim.x[i] < MEMBRANE_X) blueLeft++;
      } else if (sim.x[i] >= MEMBRANE_X) redRight++;
    }
    const drift = Math.abs(sim.kineticEnergy() - state.energyStart) / state.energyStart;
    const lines = [
      `${sim.n} particles · ${blueLeft} of ${blues} blue on the left · ${redRight} of ${sim.n - blues} red on the right`,
      `${sim.membraneBounces.toLocaleString()} bounces off the membrane · ` +
        `${sim.particleCollisions.toLocaleString()} collisions · energy drift ${drift.toExponential(0)}`,
    ];
    for (const text of lines) {
      const p = document.createElement('p');
      p.textContent = text;
      el.status.append(p);
    }
  }

  function render() {
    drawBox();
    drawTimeline();
    updateReadouts();
  }

  // ---------- playback ----------

  function setPlaying(on) {
    state.playing = on && !!state.sim;
    // SVG elements have no .hidden property, so set the attribute directly.
    el.iconPlay.toggleAttribute('hidden', state.playing);
    el.iconPause.toggleAttribute('hidden', !state.playing);
    el.playLabel.textContent = state.playing ? 'Pause' : 'Play';
    el.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
    if (state.playing) {
      state.lastTs = 0;
      requestAnimationFrame(tick);
    }
  }

  function tick(ts) {
    if (!state.playing) return;
    const dt = state.lastTs ? Math.min(MAX_STEP, (ts - state.lastTs) / 1000) : 0;
    state.lastTs = ts;
    state.clock += dt * parseFloat(el.rate.value);
    catchUp();
    render();
    if (ts - state.lastStatus > 250) {
      state.lastStatus = ts;
      showStatus();
    }
    requestAnimationFrame(tick);
  }

  // ---------- events ----------

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    restart();
  });
  for (const input of [el.n, el.radius, el.speed, el.seed]) input.addEventListener('input', updatePending);
  el.reseed.addEventListener('click', () => {
    el.seed.value = String(Math.floor(Math.random() * 1e6));
    saveSettings();
    updatePending();
  });
  el.membraneOn.addEventListener('change', () => {
    if (state.sim) state.sim.setMembrane(el.membraneOn.checked);
    render();
  });
  el.showMembrane.addEventListener('change', render);
  el.play.addEventListener('click', () => setPlaying(!state.playing));
  el.restart.addEventListener('click', restart);
  el.reset.addEventListener('click', resetSettings);
  for (const type of ['input', 'change']) {
    document.addEventListener(type, (e) => {
      if (SAVED.includes(e.target.id)) saveSettings();
    });
  }

  // Space: play/pause. N: new random seed and restart.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, select, textarea')) return;
    if (e.key === ' ' && !e.target.closest('button')) {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      el.reseed.click();
      restart();
    }
  });

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

  loadSettings();
  readColours();
  restart();
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(true);
})();
