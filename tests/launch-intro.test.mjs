import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/launch-intro.js', import.meta.url), 'utf8');

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, callback, options) {
      if (!listeners.has(name)) listeners.set(name, new Map());
      listeners.get(name).set(callback, options);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name, event = {}) {
      for (const [callback, options] of [...(listeners.get(name) || [])]) {
        if (options?.once) listeners.get(name).delete(callback);
        callback(event);
      }
    },
    listenerCount() { return [...listeners.values()].reduce((total, items) => total + items.size, 0); }
  };
}

function classList(...initial) {
  const classes = new Set(initial);
  return {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name)
  };
}

async function setup({ reducedMotion = false, hash = '', scrollY = 0, webgl = true, link = true, decode = 'success', hidden = false, pending = true } = {}) {
  let resolveDecode;
  let rejectDecode;
  const decoded = new Promise((resolve, reject) => { resolveDecode = resolve; rejectDecode = reject; });
  const timers = new Map();
  const frames = new Map();
  const stats = { draws: 0, buffersDeleted: 0, programsDeleted: 0, shadersDeleted: 0, contextsLost: 0, contextRequests: 0, focused: 0, removed: 0 };
  let nextId = 0;
  let now = 1000;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, LINK_STATUS: 3, ARRAY_BUFFER: 4, STATIC_DRAW: 5, FLOAT: 6, TRIANGLE_STRIP: 7,
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    getProgramParameter: () => link, useProgram() {}, bindBuffer() {}, bufferData() {},
    getAttribLocation: () => 0, enableVertexAttribArray() {}, vertexAttribPointer() {},
    viewport() {}, getUniformLocation: (_program, name) => name, uniform1f() {},
    drawArrays() { stats.draws++; },
    deleteBuffer() { stats.buffersDeleted++; },
    deleteProgram() { stats.programsDeleted++; },
    deleteShader() { stats.shadersDeleted++; },
    getExtension: () => ({ loseContext() { stats.contextsLost++; } })
  };
  const canvas = Object.assign(eventTarget(), {
    getContext() { stats.contextRequests++; return webgl ? gl : null; }
  });
  const skip = eventTarget();
  const ship = { offsetHeight: 480, style: {} };
  const intro = {
    isConnected: true,
    classList: classList(),
    querySelector: (selector) => ({ canvas, '.launch-intro-ship': ship, img: { decode: () => decoded } })[selector],
    contains: (target) => target === skip,
    remove() { stats.removed++; this.isConnected = false; }
  };
  const motion = Object.assign(eventTarget(), { matches: reducedMotion });
  const root = { classList: classList(...(pending ? ['launch-pending'] : [])) };
  const document = Object.assign(eventTarget(), {
    documentElement: root, activeElement: null, hidden,
    getElementById: (id) => ({ 'launch-intro': intro, 'launch-intro-skip': skip })[id],
    querySelector: () => ({ focus() { stats.focused++; } })
  });
  const window = Object.assign(eventTarget(), {
    matchMedia: () => motion, location: { hash }, scrollY, innerWidth: 1440, innerHeight: 900,
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame(callback) { const id = ++nextId; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id)
  });
  window.launchIntroFallback = window.setTimeout(() => root.classList.remove('launch-pending'), 5000);
  vm.runInNewContext(source, { document, window, performance: { now: () => now } });
  if (decode === 'success') resolveDecode();
  if (decode === 'failure') rejectDecode(new Error('Rocket image could not load'));
  await new Promise(setImmediate);
  return {
    intro, root, document, window, motion, canvas, ship, skip, stats, timers, frames,
    resolveDecode,
    advance(milliseconds) { now += milliseconds; return now; },
    runFrame(time) {
      now = time;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
    runTimer() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const { callback } of callbacks) callback();
    }
  };
}

function assertFinished(ui, { gpu = false } = {}) {
  assert.equal(ui.intro.isConnected, false, 'overlay is removed');
  assert.equal(ui.root.classList.contains('launch-pending'), false, 'homepage is revealed');
  assert.equal(ui.timers.size, 0, 'watchdog is cleared');
  assert.equal(ui.frames.size, 0, 'animation frame is canceled');
  assert.equal(ui.window.listenerCount(), 0, 'window listeners are removed');
  assert.equal(ui.document.listenerCount(), 0, 'document listeners are removed');
  assert.equal(ui.motion.listenerCount(), 0, 'motion listener is removed');
  assert.equal(ui.canvas.listenerCount(), 0, 'WebGL context listener is removed');
  assert.equal(ui.stats.removed, 1, 'finish is idempotent');
  if (gpu) {
    assert.equal(ui.stats.buffersDeleted, 1);
    assert.equal(ui.stats.programsDeleted, 1);
    assert.equal(ui.stats.shadersDeleted, 2);
    assert.equal(ui.stats.contextsLost, 1);
  }
}

test('intro skips immediately for reduced motion, deep links, or an already-scrolled page', async () => {
  for (const options of [{ reducedMotion: true }, { hash: '#contact' }, { scrollY: 21 }]) {
    const ui = await setup(options);
    assertFinished(ui);
    assert.equal(ui.stats.contextRequests, 0);
  }
});

test('skip reveals the page, restores focus, and releases WebGL only once', async () => {
  const ui = await setup();
  ui.document.activeElement = ui.skip;
  ui.skip.dispatch('click');
  ui.skip.dispatch('click');
  assertFinished(ui, { gpu: true });
  assert.equal(ui.stats.focused, 1);
});

test('failed image decoding fails open without requesting WebGL', async () => {
  const ui = await setup({ decode: 'failure' });
  assertFinished(ui);
  assert.equal(ui.stats.contextRequests, 0);
});

test('image decode timeout fails open and a late decode cannot restart the intro', async () => {
  const ui = await setup({ decode: 'pending' });
  assert.equal(ui.intro.isConnected, true);
  assert.deepEqual([...ui.timers.values()].map(timer => timer.delay), [2500]);
  ui.runTimer();
  ui.resolveDecode();
  await new Promise(setImmediate);
  assertFinished(ui);
  assert.equal(ui.stats.contextRequests, 0);
});

test('a background load waits for visibility before starting the intro', async () => {
  const ui = await setup({ hidden: true });
  assert.equal(ui.intro.isConnected, true);
  assert.equal(ui.root.classList.contains('launch-pending'), false);
  assert.equal(ui.stats.contextRequests, 0);
  assert.equal(ui.timers.size, 0, 'neither the head fallback nor image deadline runs in the background');
  ui.advance(10000);
  ui.document.hidden = false;
  ui.document.dispatch('visibilitychange');
  await new Promise(setImmediate);
  assert.equal(ui.intro.classList.contains('is-playing'), true);
  assert.equal(ui.root.classList.contains('launch-pending'), true);
  assert.equal(ui.stats.contextRequests, 1);
  ui.skip.dispatch('click');
  assertFinished(ui, { gpu: true });
});

test('an expired startup fallback does not suppress an eligible foreground intro', async () => {
  const ui = await setup({ pending: false });
  assert.equal(ui.intro.classList.contains('is-playing'), true);
  assert.equal(ui.root.classList.contains('launch-pending'), true);
  ui.skip.dispatch('click');
  assertFinished(ui, { gpu: true });
});

test('the image deadline counts only foreground time and permits decoding after 800ms', async () => {
  const ui = await setup({ decode: 'pending' });
  ui.advance(2000);
  ui.document.hidden = true;
  ui.document.dispatch('visibilitychange');
  assert.equal(ui.timers.size, 0);
  ui.advance(10000);
  ui.document.hidden = false;
  ui.document.dispatch('visibilitychange');
  assert.deepEqual([...ui.timers.values()].map(timer => timer.delay), [500]);
  ui.resolveDecode();
  await new Promise(setImmediate);
  assert.equal(ui.intro.classList.contains('is-playing'), true);
  assert.equal(ui.stats.contextRequests, 1);
  ui.skip.dispatch('click');
  assertFinished(ui, { gpu: true });
});

test('backgrounding pauses playback and resumes the same rocket position and foreground clock', async () => {
  const ui = await setup();
  ui.runFrame(1500);
  const position = ui.ship.style.transform;
  ui.document.hidden = true;
  ui.document.dispatch('visibilitychange');
  assert.equal(ui.intro.isConnected, true);
  assert.equal(ui.frames.size, 0);
  assert.equal(ui.timers.size, 0);
  assert.equal(ui.intro.classList.contains('is-playing'), false);
  ui.advance(10000);
  ui.document.hidden = false;
  ui.document.dispatch('visibilitychange');
  assert.equal(ui.ship.style.transform, position, 'the animation does not jump to its end');
  assert.equal(ui.stats.contextRequests, 1, 'the existing renderer is reused');
  assert.deepEqual([...ui.timers.values()].map(timer => timer.delay), [2600]);
  ui.runFrame(13850);
  assertFinished(ui, { gpu: true });
});

test('decoding completed in a background tab waits until the page is visible', async () => {
  const ui = await setup({ decode: 'pending' });
  ui.document.hidden = true;
  ui.document.dispatch('visibilitychange');
  ui.resolveDecode();
  await new Promise(setImmediate);
  assert.equal(ui.stats.contextRequests, 0);
  assert.equal(ui.timers.size, 0);
  ui.document.hidden = false;
  ui.document.dispatch('visibilitychange');
  assert.equal(ui.intro.classList.contains('is-playing'), true);
  ui.skip.dispatch('click');
  assertFinished(ui, { gpu: true });
});

test('viewport changes resize the renderer without canceling or restarting the intro', async () => {
  const ui = await setup();
  ui.runFrame(1500);
  ui.window.innerWidth = 390;
  ui.window.innerHeight = 844;
  ui.ship.offsetHeight = 354;
  ui.window.dispatch('resize');
  const ratio = Math.sqrt(320000 / (390 * 844));
  assert.equal(ui.canvas.width, Math.round(390 * ratio));
  assert.equal(ui.canvas.height, Math.round(844 * ratio));
  assert.equal(ui.intro.isConnected, true);
  assert.equal(ui.intro.classList.contains('is-playing'), true);
  assert.equal(ui.stats.contextRequests, 1);
  ui.runFrame(1600);
  const progress = .6 / 2.4;
  const travel = 844 * .7 + 354 * 1.5;
  assert.equal(ui.ship.style.transform, `translate3d(-50%, ${-travel * (.12 * progress + .88 * progress * progress)}px, 0)`);
  ui.runFrame(3850);
  assertFinished(ui, { gpu: true });
});

test('unavailable WebGL and unsuccessful shader linking fail open', async () => {
  const unavailable = await setup({ webgl: false });
  assertFinished(unavailable);
  const failedLink = await setup({ link: false });
  assertFinished(failedLink, { gpu: true });
});

test('WebGL context loss immediately releases the intro and its resources', async () => {
  const ui = await setup();
  ui.canvas.dispatch('webglcontextlost');
  assertFinished(ui, { gpu: true });
});

test('animation moves the rocket without scaling it and completes on the shared clock', async () => {
  const ui = await setup();
  assert.equal(ui.intro.classList.contains('is-playing'), true);
  assert.equal(ui.stats.draws, 1);
  ui.runFrame(2000);
  assert.equal(ui.stats.draws, 2);
  assert.match(ui.ship.style.transform, /^translate3d\(-50%, -[\d.]+px, 0\)$/);
  ui.runFrame(5000);
  assertFinished(ui, { gpu: true });
});

test('completion watchdog reveals the page even if animation frames stop', async () => {
  const ui = await setup();
  ui.runTimer();
  assertFinished(ui, { gpu: true });
});

test('navigation, focus, and reduced-motion changes cancel the intro safely', async () => {
  const cancellations = [
    (ui) => ui.document.dispatch('keydown', { key: 'Escape' }),
    (ui) => ui.document.dispatch('focusin', { target: {} }),
    (ui) => { ui.motion.matches = true; ui.motion.dispatch('change'); },
    (ui) => { ui.window.scrollY = 21; ui.window.dispatch('scroll'); },
    (ui) => ui.window.dispatch('hashchange'),
    (ui) => ui.window.dispatch('pagehide')
  ];
  for (const cancel of cancellations) {
    const ui = await setup();
    cancel(ui);
    assertFinished(ui, { gpu: true });
  }
});
