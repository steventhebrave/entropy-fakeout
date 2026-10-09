/* Entropy Fakeout: browser player. Runs the simulation, labels it, plays it back. */
(function () {
  'use strict';

  const Sim = window.EntropySim;
  const Frames = window.EntropyFrames;
  const BOX = { width: 960, height: 540 };
  const FRAME_RATES = [24, 25, 30, 50, 60];
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
    fps: $('fps'),
    exportSize: $('export-size'),
    exportBg: $('export-bg'),
    exportBtn: $('export'),
    exportStatus: $('export-status'),
    simFields: $('sim-fields'),
    labelFields: $('label-fields'),
    tries: $('tries'),
    maxClump: $('max-clump'),
    search: $('search'),
    searchStatus: $('search-status'),
    reset: $('reset'),
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
    clump: null, // clumpiness of the opening frame
    resumeAfterRun: false, // carry on playing after a rerun
    searching: false,
    stopSearch: false,
    cancelSearch: null, // stops a running worker search at once
    exporting: false,
    stopExport: false,
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
      duration: num(el.duration, 30, 1, 300),
      fps: FRAME_RATES.includes(Number(el.fps.value)) ? Number(el.fps.value) : 60,
      seed: Math.round(num(el.seed, 1, 0, 4294967295)),
    };
  }

  // Remembered in this browser between visits.
  const STORAGE_KEY = 'entropy-fakeout:settings';
  const SAVED = ['start', 'gap', 'n', 'radius', 'speed', 'duration', 'seed', 'sort-time',
    'split', 'colour', 'show-line', 'loop', 'rate', 'tries', 'max-clump', 'fps', 'export-size',
    'export-bg'];

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

  // Back to the page's built-in values. The rerun saves them over the old ones.
  function resetSettings() {
    for (const id of SAVED) {
      const input = $(id);
      if (input.type === 'checkbox') input.checked = input.defaultChecked;
      else if (input.tagName === 'SELECT') {
        input.value = ([...input.options].find((o) => o.defaultSelected) || input.options[0]).value;
      } else input.value = input.defaultValue;
    }
    el.searchStatus.textContent = '';
    syncStart();
    rerun();
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
    drawScene(ctx, rec, state.frame, sceneOptions(), dpr / s);
  }

  // What the box shows, from the current settings: also used for export.
  function sceneOptions() {
    const c = state.colours;
    const coloured = el.colour.checked && state.sort;
    return {
      labels: coloured ? state.sort.labels : null,
      colours: coloured ? [c.blue, c.red] : [c.grey], // indexed by Sim.BLUE, Sim.RED
      line: el.showLine.checked && state.sort ? { x: state.sort.boundary, colour: c.muted } : null,
    };
  }

  // Draw frame f in world units. px is one screen pixel in world units, for
  // line widths.
  function drawScene(ctx, rec, f, scene, px) {
    if (scene.line) {
      ctx.save();
      ctx.strokeStyle = scene.line.colour;
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 6 * px]);
      ctx.beginPath();
      ctx.moveTo(scene.line.x, 0);
      ctx.lineTo(scene.line.x, rec.height);
      ctx.stroke();
      ctx.restore();
    }
    Frames.drawDiscs(ctx, rec.frames, f * rec.n * 2, rec.n, rec.radius, scene.labels, scene.colours);
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
    // SVG elements have no .hidden property, so set the attribute directly.
    el.iconPlay.toggleAttribute('hidden', state.playing);
    el.iconPause.toggleAttribute('hidden', !state.playing);
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
    state.clump = Sim.clumpiness(rec.frames, 0, rec.n, state.sort.labels, rec);
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
      const open = document.createElement('p');
      const c = state.clump;
      open.textContent =
        `Opening frame ${pct(state.order[0])} sorted` +
        (c ? ` · clumpiness ${pct(c.worst)} (top left ${pct(c.topLeft)}, bottom right ${pct(c.bottomRight)})` : '');
      el.status.append(open);
    }
  }

  async function runSimulation() {
    const run = ++state.run;
    const settings = physicsSettings();
    el.n.value = settings.n;
    saveSettings();
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
        fps: settings.fps,
        chunk: Math.max(2, Math.round(6000 / settings.n)),
        onProgress: (done, total) => {
          if (run !== state.run) throw new Error('superseded');
          el.run.textContent = `Simulating… ${Math.floor((100 * done) / total)}%`;
          return breathe();
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
    el.run.disabled = state.searching;
    el.run.textContent = 'Run simulation';
    updatePending();
    state.playTime = 0;
    state.frame = 0;
    relabel();
    return true;
  }

  // Let the page repaint and respond during a long calculation. Each pause
  // costs at least 4 ms (the browser's minimum timer delay), so pause at
  // most every 25 ms of work rather than every chunk.
  let lastBreath = 0;
  function breathe() {
    const now = performance.now();
    if (now - lastBreath < 25) return null;
    return new Promise((resolve) =>
      setTimeout(() => {
        lastBreath = performance.now();
        resolve();
      }, 0)
    );
  }

  // Run the simulation, then carry on playing if it was playing before.
  function rerun() {
    state.resumeAfterRun = state.resumeAfterRun || state.playing;
    return runSimulation().then((done) => {
      if (!done) return;
      if (state.resumeAfterRun) setPlaying(true);
      state.resumeAfterRun = false;
    });
  }

  // ---------- seed search ----------
  //
  // Seeds are independent, so they run in parallel on Web Workers, one per
  // CPU core. Each worker runs this same sim.js, so its results match the
  // player's exactly. If workers are unavailable it falls back to running
  // seeds one at a time on the page.

  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const randomSeed = () => Math.floor(Math.random() * 1e6);
  const distance = (r) => Math.abs(r.mix - 0.5);
  const fmt = (v) => v.toLocaleString();

  function setSearching(on) {
    state.searching = on;
    el.search.textContent = on ? 'Stop' : 'Find best seed';
    el.simFields.disabled = on;
    el.labelFields.disabled = on;
    el.tries.disabled = on;
    el.maxClump.disabled = on || el.start.value !== 'corners';
    el.run.disabled = on;
    el.reset.disabled = on;
  }

  let workerUrl = null;
  function searchWorkerUrl() {
    if (!workerUrl) {
      const code = `
        const Sim = ${Sim.source};
        onmessage = async (e) => {
          const { base, opts, index, seed } = e.data;
          try {
            const stats = await Sim.openingStats(Sim.createInitialState({ ...base, seed }), opts);
            postMessage({ index, seed, mix: stats.mix, clump: stats.clump });
          } catch (err) {
            postMessage({ index, seed, error: err.message });
          }
        };`;
      workerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    }
    return workerUrl;
  }

  // Hands seeds to workers one at a time until the search is over. Resolves
  // when every worker is idle; rejects if the workers themselves fail.
  function searchWithWorkers(job) {
    return new Promise((resolve, reject) => {
      const count = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, job.tries));
      const workers = [];
      let busy = 0;
      let finished = false;
      const finish = (err) => {
        if (finished) return;
        finished = true;
        state.cancelSearch = null;
        workers.forEach((w) => w.terminate());
        if (err) reject(err);
        else resolve();
      };
      const feed = (w) => {
        if (job.over()) {
          if (busy === 0) finish();
          return;
        }
        const index = job.handed++;
        busy++;
        w.postMessage({ base: job.base, opts: job.opts, index, seed: job.seedFor(index) });
      };
      // Stop: drop seeds in flight rather than wait for them.
      state.cancelSearch = () => finish();
      job.cores = count;
      for (let k = 0; k < count; k++) {
        const w = new Worker(searchWorkerUrl());
        w.onmessage = (e) => {
          busy--;
          job.take(e.data);
          feed(w);
        };
        w.onerror = (e) => {
          e.preventDefault();
          finish(new Error(e.message || 'A search worker failed to start.'));
        };
        workers.push(w);
      }
      workers.forEach(feed);
    });
  }

  async function searchOnPage(job) {
    job.cores = 1;
    while (!job.over()) {
      const index = job.handed++;
      const seed = job.seedFor(index);
      try {
        const stats = await Sim.openingStats(Sim.createInitialState({ ...job.base, seed }), {
          ...job.opts,
          onProgress: () => (state.stopSearch ? Promise.reject(new Error('stopped')) : breathe()),
        });
        job.take({ index, seed, ...stats });
      } catch (err) {
        if (state.stopSearch) return;
        job.take({ index, seed, error: err.message });
      }
    }
  }

  async function searchSeeds() {
    if (state.searching) {
      state.stopSearch = true;
      if (state.cancelSearch) state.cancelSearch();
      return;
    }
    const settings = physicsSettings();
    const tries = Math.round(num(el.tries, 20, 2, Infinity));
    el.tries.value = tries;
    const report = (text) => {
      el.searchStatus.textContent = text;
    };

    // Catch settings that can't be laid out before starting any workers.
    try {
      Sim.createInitialState({ ...settings, ...BOX });
    } catch (err) {
      return report(err.message);
    }

    // Clumpiness only applies to the corner start. An empty box means no limit.
    const limit = parseFloat(el.maxClump.value);
    const maxClump = settings.start === 'corners' && Number.isFinite(limit) ? limit / 100 : null;

    // The current seed goes first, so it wins any tie. The rest are random,
    // unique, and drawn from the full 32-bit range so long searches don't
    // run out.
    const used = new Set([settings.seed]);
    const job = {
      base: { ...settings, ...BOX },
      opts: {
        sortTime: num(el.sortTime, 15, 0, Math.floor(settings.duration * settings.fps + 1e-9) / settings.fps),
        fps: settings.fps,
        split: el.split.value,
      },
      tries,
      maxClump,
      handed: 0,
      done: 0,
      passed: 0, // within the clumpiness limit
      best: null, // closest to 50% among those within the limit
      leastClumpy: null,
      perfect: false,
      error: null,
      cores: 0,
      seedFor(index) {
        if (index === 0) return settings.seed;
        let seed;
        do seed = Math.floor(Math.random() * 4294967296);
        while (used.has(seed));
        used.add(seed);
        return seed;
      },
      // Nothing can beat exactly 50% within the limit, so stop handing out
      // seeds once one scores that. Seeds already running still finish, and
      // the earliest perfect seed wins.
      over() {
        return this.handed >= this.tries || this.perfect || this.error || state.stopSearch;
      },
      take(result) {
        if (result.error) {
          this.error = this.error || result.error;
          return;
        }
        this.done++;
        if (result.clump && (!this.leastClumpy || result.clump.worst < this.leastClumpy.clump.worst)) {
          this.leastClumpy = result;
        }
        if (Sim.acceptable(result, this.maxClump)) {
          this.passed++;
          const better = (a, b) => distance(a) < distance(b) || (distance(a) === distance(b) && a.index < b.index);
          if (!this.best || better(result, this.best)) this.best = result;
          if (result.mix === 0.5) this.perfect = true;
        }
        progress();
      },
    };

    const describe = (r) =>
      `seed ${r.seed}, opening frame ${pct(r.mix)} sorted` + (r.clump ? `, clumpiness ${pct(r.clump.worst)}` : '');
    const started = performance.now();
    const rate = () => job.done / Math.max(0.001, (performance.now() - started) / 1000);
    const cores = () => (job.cores === 1 ? '1 core' : `${job.cores} cores`);
    let lastReport = 0;
    const progress = () => {
      const now = performance.now();
      if (now - lastReport < 100) return;
      lastReport = now;
      report(
        `Tried ${fmt(job.done)} of ${fmt(tries)} · ${rate().toFixed(0)} seeds/s on ${cores()} · ` +
          (maxClump == null ? '' : `${fmt(job.passed)} within the clumpiness limit · `) +
          (job.best ? `best so far: ${describe(job.best)}` : 'none within the limit yet')
      );
    };

    state.stopSearch = false;
    setSearching(true);
    report(`Starting ${fmt(tries)} seeds…`);
    try {
      await searchWithWorkers(job);
    } catch (err) {
      // Workers unavailable here: carry on one seed at a time on the page.
      await searchOnPage(job);
    }
    setSearching(false);

    if (job.error) return report(job.error);
    if (job.done === 0) return report('Search stopped before any seed finished.');
    if (!job.best) {
      return report(
        `None of the ${fmt(job.done)} seeds tried had clumpiness at or below ${pct(maxClump)}. ` +
          `The least clumpy was seed ${job.leastClumpy.seed} at ${pct(job.leastClumpy.clump.worst)}. ` +
          'Raise the limit or try more seeds.'
      );
    }
    const best = job.best;
    const speed = `${rate().toFixed(0)} seeds/s on ${cores()}`;
    const passed = maxClump == null ? '' : `${fmt(job.passed)} of ${fmt(job.done)} were within the clumpiness limit. `;
    if (best.mix === 0.5) {
      report(
        `Found ${describe(best)} after ${fmt(job.done)} ${job.done === 1 ? 'try' : 'tries'}. ` +
          `${passed}Stopped there, since no seed can beat an exact 50% (${speed}).`
      );
    } else {
      const scope = job.done < tries ? `Stopped after ${fmt(job.done)} of ${fmt(tries)} seeds` : `Best of ${fmt(job.done)} seeds`;
      report(`${scope}: ${describe(best)}. ${passed}${speed}.`);
    }
    el.seed.value = String(best.seed);
    saveSettings();
    rerun();
  }

  // ---------- exporting frames ----------

  const EXPORT_SIZES = { '4k': [3840, 2160], hd: [1920, 1080] };

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
    if (!state.rec || !state.sort) return report('Run the simulation first.');

    // Everything the frames depend on is captured now, so changing settings
    // while exporting doesn't affect them.
    const rec = state.rec;
    const scene = sceneOptions();
    const box = state.colours.box;
    const transparent = el.exportBg.value === 'transparent';
    const [width, height] = EXPORT_SIZES[el.exportSize.value] || EXPORT_SIZES['4k'];
    const scale = width / rec.width;
    const seed = state.ranWith.seed;
    const name = `fakeout_seed-${seed}_${rec.fps}fps_${width}x${height}`;

    setPlaying(false);
    state.exporting = true;
    state.stopExport = false;
    el.exportBtn.textContent = 'Stop export';
    const started = performance.now();
    try {
      const result = await Frames.exportFrames({
        name,
        count: rec.frameCount,
        width,
        height,
        stopped: () => state.stopExport,
        draw: (ctx, f) => {
          if (!transparent) {
            ctx.fillStyle = box;
            ctx.fillRect(0, 0, width, height);
          }
          ctx.setTransform(scale, 0, 0, scale, 0, 0);
          drawScene(ctx, rec, f, scene, 1);
        },
        onProgress: (done, total) => {
          const secs = (performance.now() - started) / 1000;
          const left = (secs / done) * (total - done);
          report(`Saving frame ${fmt(done)} of ${fmt(total)} · about ${Math.ceil(left)} s left`);
        },
      });
      if (!result.stopped) {
        report(`Saved ${fmt(result.saved)} frames at ${width} × ${height}, ${rec.fps} fps, to ${result.where}.`);
      } else if (result.kept) {
        report(`Stopped. ${fmt(result.saved)} frames were saved to ${result.where}.`);
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
    runSimulation();
  });
  for (const input of [el.gap, el.n, el.radius, el.speed, el.duration, el.seed]) {
    input.addEventListener('input', updatePending);
  }
  const syncStart = () => {
    el.gap.disabled = el.start.value !== 'corners';
    el.maxClump.disabled = el.start.value !== 'corners' || state.searching;
  };
  el.start.addEventListener('change', () => {
    syncStart();
    updatePending();
  });
  syncStart();
  el.reseed.addEventListener('click', () => {
    el.seed.value = String(randomSeed());
    saveSettings();
    updatePending();
  });
  el.search.addEventListener('click', searchSeeds);
  el.exportBtn.addEventListener('click', exportRun);
  el.reset.addEventListener('click', resetSettings);
  for (const type of ['input', 'change']) {
    document.addEventListener(type, (e) => {
      if (SAVED.includes(e.target.id)) saveSettings();
    });
  }
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
    } else if ((e.key === 'n' || e.key === 'N') && !state.searching) {
      e.preventDefault();
      el.reseed.click();
      rerun();
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

  loadSettings();
  syncStart();
  readColours();
  render();
  runSimulation().then(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && state.rec) setPlaying(true);
  });
})();
