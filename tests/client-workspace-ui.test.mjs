import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/client-portal.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../client.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../css/client-workspace.css', import.meta.url), 'utf8');
const fixture = () => ({ id: 'project-test', business: 'Workspace test', contact: 'Test Client', project: 'Website build', status: 'active', progress: 35, supportStatus: 'none', supportPlan: '', canSubmitEdits: true, milestones: [{ label: 'Kickoff', state: 'complete' }, { label: 'Build', state: 'current' }], messages: [], approvals: [], requests: [], files: [] });
const flush = () => new Promise(setImmediate);

async function boot(options = {}) {
  const nodes = new Map(), events = {}, calls = { requests: [], uploads: [], messages: [], magic: [], approvals: [], downloads: [] };
  let project = options.project === undefined ? fixture() : options.project, loadError = null, uploadAttempt = 0, authCallback;
  const element = () => ({
    hidden: false, disabled: false, value: '', files: [], textContent: '', innerHTML: '', dataset: {}, style: {}, attributes: {}, handlers: {},
    scrollHeight: 100, scrollTop: 0, clientHeight: 100,
    classList: { add() {}, remove() {} }, setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    querySelector(selector) { return get(selector); }, reset() { this.resetCount = (this.resetCount || 0) + 1; },
    replaceChildren(...children) { this.children = children; }, click() { this.clicked = true; }
  });
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const Portal = {
    getSession: async () => options.signedOut ? null : ({ user: { email: 'test@example.test' } }),
    loadClient: async () => { if (loadError) throw loadError; return project; },
    loadClients: async () => { if (loadError) throw loadError; return project ? [project] : []; },
    markMessagesRead: async () => {}, subscribe: () => () => {}, formatTime: () => 'Oct 29',
    onAuthStateChange: (callback) => { authCallback = callback; },
    sendMagicLink: async (...args) => calls.magic.push(args), signOut: async () => {},
    addMessage: async (...args) => calls.messages.push(args), respondToApproval: async (...args) => calls.approvals.push(args),
    createEditRequest: async (...args) => { calls.requests.push(args); return { id: 'request-1' }; },
    uploadProjectFile: async (...args) => { calls.uploads.push(args); uploadAttempt += 1; if (options.failUploadAt === uploadAttempt) throw new Error('Connection interrupted.'); return { id: `file-${uploadAttempt}` }; },
    getProjectFileUrl: async (file) => { calls.downloads.push(file); return 'https://storage.example.test/signed-file?token=test'; }
  };
  const sandbox = {
    window: { LaunchPointPortal: Portal, addEventListener: (name, callback) => { events[name] = callback; } },
    document: { body: { dataset: { authState: 'loading' } }, querySelector: get, title: '', hidden: false, addEventListener: (name, callback) => { events[name] = callback; }, createElement: element, createTextNode: (text) => ({ textContent: text }) },
    location: { search: '?id=project-test', href: 'https://mylaunch.dev/client.html?id=project-test' },
    URL, URLSearchParams, Date, Intl, setTimeout: () => 1, clearTimeout() {}, setInterval() {}
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox); await flush();
  return { get, calls, sandbox, events, setProject(value) { project = value; }, setLoadError(value) { loadError = value; }, auth: (event) => authCallback(event), async fire(selector, type = 'submit') { const node = get(selector); await node.handlers[type]({ preventDefault() {}, currentTarget: node, target: node }); await flush(); } };
}

test('client workspace keeps private email login, real branding, and no fabricated project HTML', () => {
  assert.match(html, /noindex, nofollow/);
  assert.match(html, /launchpoint-logo-v2\.png/);
  assert.match(html, /portal-data\.js\?v=20261029-portal1/);
  assert.doesNotMatch(html, /Maya|Nov 14|Website &amp; booking flow/);
  assert.match(html, /role="progressbar"/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
});

test('signed-out visitors get email magic-link auth for the project URL', async () => {
  const ui = await boot({ signedOut: true });
  assert.equal(ui.sandbox.document.body.dataset.authState, 'signed-out');
  ui.get('#auth-email').value = 'test@example.test';
  await ui.fire('#auth-form');
  assert.deepEqual(ui.calls.magic[0], ['test@example.test', 'https://mylaunch.dev/client.html?id=project-test']);
});

test('missing or unauthorized project has an honest unavailable state', async () => {
  const ui = await boot({ project: null });
  assert.equal(ui.get('#portal-content').hidden, true);
  assert.equal(ui.get('#portal-unavailable').hidden, false);
  assert.match(ui.get('#portal-unavailable-copy').textContent, /not shared with your signed-in email/);
});

test('project progress is clamped and empty states show no invented requests', async () => {
  const ui = await boot({ project: { ...fixture(), progress: 140 } });
  assert.equal(ui.get('#portal-progress').attributes['aria-valuenow'], '100');
  assert.equal(ui.get('#portal-progress-number').textContent, '100%');
  assert.match(ui.get('#portal-request-list').innerHTML, /first edit/);
  assert.equal(ui.get('#portal-review-button').hidden, true);
});

test('completed projects without active support cannot submit edits or upload but can message', async () => {
  const ui = await boot({ project: { ...fixture(), status: 'complete', supportStatus: 'paused', canSubmitEdits: false } });
  assert.equal(ui.get('#portal-request-fields').disabled, true);
  assert.equal(ui.get('#portal-request-submit').disabled, true);
  assert.equal(ui.get('#project-files').disabled, true);
  await ui.fire('#portal-request-form');
  assert.equal(ui.calls.requests.length, 0);
  ui.get('#portal-reply-input').value = 'Can we discuss continued support?';
  await ui.fire('#portal-reply-form');
  assert.equal(ui.calls.messages.length, 1);
});

test('background refresh preserves text and file drafts', async () => {
  const ui = await boot();
  ui.get('#request-title').value = 'Draft title'; ui.get('#request-description').value = 'Draft details'; ui.get('#portal-reply-input').value = 'Draft message';
  const files = [{ name: 'reference.png', type: 'image/png', size: 100 }]; ui.get('#request-files').files = files;
  ui.setProject({ ...fixture(), progress: 50 }); await ui.events.focus();
  assert.equal(ui.get('#request-title').value, 'Draft title');
  assert.equal(ui.get('#request-description').value, 'Draft details');
  assert.equal(ui.get('#portal-reply-input').value, 'Draft message');
  assert.equal(ui.get('#request-files').files, files);
  assert.equal(ui.get('#portal-progress-number').textContent, '50%');
});

test('refresh failure explains stale updates instead of claiming support was canceled', async () => {
  const ui = await boot({ project: { ...fixture(), supportStatus: 'active' } });
  ui.setLoadError(new Error('Subscription verification unavailable.')); await ui.events.focus();
  assert.match(ui.get('#portal-sync-status').textContent, /couldn’t refresh/);
  assert.equal(ui.get('#portal-care-status').textContent, 'Ongoing support active');
});

test('unverified subscription closes new edits with temporary-error wording, not cancellation', async () => {
  const ui = await boot({ project: { ...fixture(), status: 'complete', supportStatus: 'paused', subscriptionStatus: 'verification_unavailable', subscriptionError: 'Temporarily unavailable', canSubmitEdits: false } });
  assert.equal(ui.get('#portal-care-status').textContent, 'Support check unavailable');
  assert.match(ui.get('#portal-care-copy').textContent, /couldn’t verify your subscription/);
  assert.match(ui.get('#portal-edit-access').textContent, /temporarily unavailable/);
  assert.equal(ui.get('#portal-request-submit').disabled, true);
});

test('edit fields use the same limits as the backend', () => {
  assert.match(html, /id="request-title"[^>]+maxlength="120"/);
  assert.match(html, /id="request-description"[^>]+maxlength="5000"/);
  assert.match(html, /id="request-page-url"[^>]+maxlength="2048"/);
});

test('request attachment retries keep one request and upload only remaining files', async () => {
  const ui = await boot({ failUploadAt: 2 });
  ui.get('#request-title').value = 'Replace photos'; ui.get('#request-description').value = 'Use the attached images';
  ui.get('#request-files').files = [{ name: 'one.png', type: 'image/png', size: 100 }, { name: 'two.png', type: 'image/png', size: 200 }];
  await ui.fire('#portal-request-form');
  assert.equal(ui.calls.requests.length, 1);
  assert.match(ui.get('#portal-request-status').textContent, /request is saved/);
  assert.equal(ui.get('#portal-request-fields').disabled, true);
  await ui.fire('#portal-request-form');
  assert.equal(ui.calls.requests.length, 1);
  assert.deepEqual(ui.calls.uploads.map((args) => args[1].name), ['one.png', 'two.png', 'two.png']);
  assert.equal(ui.get('#portal-request-fields').disabled, false);
  assert.match(ui.get('#portal-request-status').textContent, /Request sent/);
});

test('file rules reject HTML, excess count, empty files, MIME mismatch, and oversized files before saving', async () => {
  for (const files of [
    [{ name: 'script.html', type: 'text/html', size: 100 }],
    Array.from({ length: 6 }, (_, index) => ({ name: `${index}.txt`, type: 'text/plain', size: 1 })),
    [{ name: 'empty.txt', type: 'text/plain', size: 0 }],
    [{ name: 'fake.png', type: 'text/html', size: 100 }],
    [{ name: 'big.pdf', type: 'application/pdf', size: 10 * 1024 * 1024 + 1 }],
    [{ name: `${'long'.repeat(45)}.pdf`, type: 'application/pdf', size: 100 }]
  ]) {
    const ui = await boot(); ui.get('#request-title').value = 'Change'; ui.get('#request-description').value = 'Details'; ui.get('#request-files').files = files;
    await ui.fire('#portal-request-form');
    assert.equal(ui.calls.requests.length, 0); assert.equal(ui.get('#portal-request-status').dataset.error, 'true');
  }
});

test('unsafe URL schemes are rejected before saving and untrusted text is escaped', async () => {
  const project = { ...fixture(), requests: [{ id: 'r1', title: '<img src=x>', description: '<script>bad</script>', pageUrl: 'javascript:alert(1)', status: 'submitted' }] };
  const ui = await boot({ project });
  assert.match(ui.get('#portal-request-list').innerHTML, /&lt;img src=x&gt;/);
  assert.doesNotMatch(ui.get('#portal-request-list').innerHTML, /href="javascript|<script>/);
  ui.get('#request-title').value = 'Change'; ui.get('#request-description').value = 'Details'; ui.get('#request-page-url').value = 'javascript:alert(1)';
  await ui.fire('#portal-request-form'); assert.equal(ui.calls.requests.length, 0);
});

test('standalone upload retries do not repeat successful files and can release remaining ones', async () => {
  const ui = await boot({ failUploadAt: 2 });
  ui.get('#project-files').files = [{ name: 'one.txt', type: 'text/plain', size: 100 }, { name: 'two.txt', type: 'text/plain', size: 200 }];
  await ui.fire('#portal-file-form'); assert.equal(ui.get('#portal-file-finish').hidden, false);
  await ui.fire('#portal-file-form');
  assert.deepEqual(ui.calls.uploads.map((args) => args[1].name), ['one.txt', 'two.txt', 'two.txt']);
  assert.equal(ui.get('#project-files').disabled, false);
});

test('sign-out clears form state and removes the authenticated workspace', async () => {
  const ui = await boot(); await ui.fire('#sign-out-button', 'click');
  assert.equal(ui.sandbox.document.body.dataset.authState, 'signed-out');
  assert.equal(ui.get('#portal-content').hidden, true);
  assert.ok(ui.get('#portal-request-form').resetCount);
  assert.equal(ui.get('#sign-out-button').disabled, false);
});
