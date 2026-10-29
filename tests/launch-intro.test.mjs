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

async function setup({ reducedMotion = false, hash = '', scrollY = 0, webgl = true, link = true, decode = 'success' } = {}) {
  let resolveDecode;
  let rejectDecode;
  const decoded = new Promise((resolve, reject) => { resolveDecode = resolve; rejectDecode = reject; });
  const timers = new Map();
  const frames = new Map();
  const stats = { draws: 0, buffersDeleted: 0, programsDeleted: 0, shadersDeleted: 0, contextsLost: 0, contextRequests: 0, focused: 0, removed: 0 };
  let nextId = 0;
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
  const root = { classList: classList('launch-pending') };
  const document = Object.assign(eventTarget(), {
    documentElement: root, activeElement: null, hidden: false,
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
  vm.runInNewContext(source, { document, window, performance: { now: () => 1000 } });
  if (decode === 'success') resolveDecode();
  if (decode === 'failure') rejectDecode(new Error('Rocket image could not load'));
  await new Promise(setImmediate);
  return {
    intro, root, document, window, motion, canvas, ship, skip, stats, timers, frames,
    resolveDecode,
    runFrame(time) {
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
  ui.runTimer();
  ui.resolveDecode();
  await new Promise(setImmediate);
  assertFinished(ui);
  assert.equal(ui.stats.contextRequests, 0);
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

test('navigation, focus, visibility, motion, and viewport changes cancel the intro safely', async () => {
  const cancellations = [
    (ui) => ui.document.dispatch('keydown', { key: 'Escape' }),
    (ui) => ui.document.dispatch('focusin', { target: {} }),
    (ui) => { ui.document.hidden = true; ui.document.dispatch('visibilitychange'); },
    (ui) => { ui.motion.matches = true; ui.motion.dispatch('change'); },
    (ui) => { ui.window.scrollY = 21; ui.window.dispatch('scroll'); },
    (ui) => ui.window.dispatch('resize'),
    (ui) => ui.window.dispatch('hashchange'),
    (ui) => ui.window.dispatch('pagehide')
  ];
  for (const cancel of cancellations) {
    const ui = await setup();
    cancel(ui);
    assertFinished(ui, { gpu: true });
  }
});
