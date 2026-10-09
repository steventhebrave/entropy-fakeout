/* One-Way Membrane: a live gas sorted by a membrane that lets blue through
   leftwards and red through rightwards. Shares its physics with the fake-out. */
(function () {
  'use strict';

  const Sim = window.EntropySim;
  const Frames = window.EntropyFrames;
  const BOX = { width: 960, height: 540 };
  const MEMBRANE_X = BOX.width / 2;
  const SAMPLE = 0.1; // seconds between sortedness samples
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
    exportFps: $('export-fps'),
    exportDuration: $('export-duration'),
    exportSize: $('export-size'),
    exportBg: $('export-bg'),
    exportBtn: $('export'),
    exportStatus: $('export-status'),
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
    clock: 0, // playback time in seconds; the simulation catches up to it
    pos: null, // positions at the clock: x0, y0, x1, y1, ...
    scratch: null,
    history: [], // sortedness every SAMPLE seconds
    exporting: false,
    stopExport: false,
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
  const SAVED = ['n', 'radius', 'speed', 'seed', 'rate', 'membrane-on', 'show-membrane', 'export-fps',
    'export-duration', 'export-size', 'export-bg'];

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
    state.clock = 0;
    state.pos = state.sim.sampleInto(0, new Float64Array(settings.n * 2));
    state.scratch = new Float64Array(settings.n * 2);
    state.history = [sortedness(state.pos)];
    state.ranWith = settings;
    updatePending();
    showStatus();
    render();
  }

  // Share of particles on their own colour's side: blue left, red right.
  function sortedness(pos) {
    const { labels } = state;
    let good = 0;
    for (let i = 0; i < labels.length; i++) {
      if ((pos[2 * i] < MEMBRANE_X) === (labels[i] === Sim.BLUE)) good++;
    }
    return good / labels.length;
  }

  // Bring the simulation up to the playback clock, sampling sortedness every
  // SAMPLE seconds on the way. The trajectory doesn't depend on where it
  // stops, so a seed gives the same run at any playback speed or frame rate.
  function catchUp() {
    const { sim } = state;
    while (state.history.length * SAMPLE <= state.clock) {
      const t = state.history.length * SAMPLE;
      sim.advanceTo(t);
      state.history.push(sortedness(sim.sampleInto(t, state.scratch)));
    }
    sim.advanceTo(state.clock);
    sim.sampleInto(state.clock, state.pos);
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

  // What the box shows, from the current settings: also used for export.
  function sceneOptions() {
    const c = state.colours;
    return {
      membrane: el.showMembrane.checked ? (el.membraneOn.checked ? c.ink : c.line) : null,
      colours: [c.blue, c.red], // indexed by Sim.BLUE, Sim.RED
    };
  }

  // Draw positions pos in world units. px is one screen pixel in world
  // units, for line widths. The membrane is a dashed line: dark while it
  // works, faint while it is off.
  function drawScene(ctx, pos, scene, px) {
    if (scene.membrane) drawMembrane(ctx, scene.membrane, px);
    Frames.drawDiscs(ctx, pos, 0, state.labels.length, state.sim.r, state.labels, scene.colours);
  }

  function drawMembrane(ctx, colour, px) {
    ctx.save();
    ctx.strokeStyle = colour;
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
    if (!state.sim) {
      const membrane = sceneOptions().membrane;
      if (membrane) drawMembrane(ctx, membrane, dpr / s);
      return;
    }
    drawScene(ctx, state.pos, sceneOptions(), dpr / s);
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
    const span = Math.max(MIN_SPAN, state.clock);
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
    const dt = SAMPLE;
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
    el.time.textContent = `${state.clock.toFixed(2)} s`;
    el.order.textContent = `${Math.round(sortedness(state.pos) * 100)}%`;
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
        if (state.pos[2 * i] < MEMBRANE_X) blueLeft++;
      } else if (state.pos[2 * i] >= MEMBRANE_X) redRight++;
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

  // ---------- exporting frames ----------

  const EXPORT_SIZES = { '4k': [3840, 2160], hd: [1920, 1080] };

  // Re-runs the current settings from the start, sampling at the chosen frame
  // rate. Trajectories don't depend on how they're sampled, so this is the
  // same run as on screen, as long as the membrane isn't switched mid-run.
  async function exportRun() {
    if (state.exporting) {
      state.stopExport = true;
      return;
    }
    const report = (text) => {
      el.exportStatus.textContent = text;
    };
    const blocked = Frames.unavailableReason();
    if (blocked) return report(blocked);
    if (!state.ranWith) return report('Start a run first.');

    const settings = state.ranWith;
    const fps = [24, 25, 30, 50, 60].includes(Number(el.exportFps.value)) ? Number(el.exportFps.value) : 60;
    const duration = num(el.exportDuration, 60, 1, 600);
    const count = Math.floor(duration * fps + 1e-9) + 1;
    const [width, height] = EXPORT_SIZES[el.exportSize.value] || EXPORT_SIZES['4k'];
    const scale = width / BOX.width;
    const transparent = el.exportBg.value === 'transparent';
    const box = state.colours.box;
    const scene = sceneOptions();
    const sim = new Sim.Simulator({
      ...Sim.createInitialState({ ...settings, ...BOX, start: 'random' }),
      membrane: { x: MEMBRANE_X, labels: state.labels, on: el.membraneOn.checked },
    });
    const pos = new Float64Array(settings.n * 2);
    const name = `membrane_seed-${settings.seed}_${fps}fps_${width}x${height}`;

    setPlaying(false);
    state.exporting = true;
    state.stopExport = false;
    el.exportBtn.textContent = 'Stop export';
    const started = performance.now();
    try {
      const result = await Frames.exportFrames({
        name,
        count,
        width,
        height,
        stopped: () => state.stopExport,
        draw: (ctx, k) => {
          if (!transparent) {
            ctx.fillStyle = box;
            ctx.fillRect(0, 0, width, height);
          }
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          sim.advanceTo(k / fps);
          drawScene(ctx, sim.sampleInto(k / fps, pos), scene, 1);
        },
        onProgress: (done, total) => {
          const secs = (performance.now() - started) / 1000;
          const left = (secs / done) * (total - done);
          report(`Saving frame ${done.toLocaleString()} of ${total.toLocaleString()} · about ${Math.ceil(left)} s left`);
        },
      });
      if (!result.stopped) {
        report(`Saved ${result.saved.toLocaleString()} frames at ${width} × ${height}, ${fps} fps, to ${result.where}.`);
      } else if (result.kept) {
        report(`Stopped. ${result.saved.toLocaleString()} frames were saved to ${result.where}.`);
      } else {
        report('Stopped. Nothing was saved.');
      }
    } catch (err) {
      report(err.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${err.message}`);
    } finally {
      state.exporting = false;
      el.exportBtn.textContent = 'Export frames…';
    }
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
    if (state.sim) state.sim.setMembrane(el.membraneOn.checked, state.clock);
    render();
  });
  el.showMembrane.addEventListener('change', render);
  el.play.addEventListener('click', () => setPlaying(!state.playing));
  el.restart.addEventListener('click', restart);
  el.reset.addEventListener('click', resetSettings);
  el.exportBtn.addEventListener('click', exportRun);
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
