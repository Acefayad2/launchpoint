import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/dashboard.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
const fields = ['business', 'contact', 'email', 'project', 'status', 'summary', 'nextStep', 'nextCopy', 'targetDate', 'supportPlan', 'stripeSubscriptionId'];
const fixture = (id = 'client-one') => ({ id, slug: id, business: 'AMG', contact: 'Client contact', email: 'client@example.com', project: 'Website build', status: 'active', progress: 0, nextStep: 'Review draft', nextCopy: '', targetDate: '', value: '', summary: '', lastContact: 'Not contacted', unread: 0, milestones: [], messages: [], approvals: [], requests: [], files: [], supportStatus: 'none', supportPlan: '', stripeSubscriptionId: '', subscriptionStatus: '', subscriptionCheckedAt: null, canSubmitEdits: true });

async function setup({ inviteFails = false, saveFails = false, clients = [fixture()] } = {}) {
  const nodes = new Map();
  const windowEvents = {};
  const calls = { create: [], invitations: [], projects: [], uploads: [], subscriptions: [], requests: [] };
  let realtime;
  const get = (selector) => {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        hidden: true, disabled: false, value: '', textContent: '', innerHTML: '', checked: false, files: [], events: {}, dataset: {},
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle: (name, force) => force ? classes.add(name) : classes.delete(name) },
        addEventListener(name, callback) { this.events[name] = callback; },
        querySelector: get, querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}, focus() {}, select() {},
        showModal() { this.open = true; }, close() { this.open = false; }, reset() { this.didReset = true; },
        elements: { namedItem: (name) => get(`field:${name}`) }
      });
    }
    return nodes.get(selector);
  };
  const panels = ['overview', 'clients', 'messages', 'payments', 'project'].map((name) => {
    const panel = get(`#${name}-view`); panel.dataset.viewPanel = name; return panel;
  });
  const Portal = {
    getSession: async () => ({ user: { email: 'admin@example.com' } }), getRole: async () => 'admin',
    adminAccess: async () => ({ isAdmin: true, verified: true, requiresVerification: false, expiresAt: null }),
    signOutAdmin: async () => {},
    loadClients: async () => structuredClone(clients), subscribe: (_, callback) => { realtime = callback; return () => {}; },
    initials: () => 'AM', formatTime: (value) => value || 'Not contacted', onAuthStateChange() {},
    getPaymentIntegrationStatus: async () => ({ stripeConnected: false, quoConnected: false }),
    updateProject: async (id, draft) => { calls.projects.push({ id, draft }); if (saveFails) throw new Error('Save unavailable'); Object.assign(clients.find((item) => item.id === id), draft); },
    createClient: async (data) => { calls.create.push(data); const created = { ...fixture('client-new'), ...data }; clients.push(created); return { id: created.id, slug: created.slug }; },
    sendMagicLink: async (...args) => { calls.invitations.push(args); if (inviteFails) throw new Error('Email rate limit'); },
    uploadProjectFile: async (...args) => { calls.uploads.push(args); },
    syncSubscription: async (id) => { calls.subscriptions.push(id); },
    updateEditRequest: async (...args) => { calls.requests.push(args); },
    markMessagesRead: async () => {}
  };
  const sandbox = {
    window: { LaunchPointPortal: Portal, addEventListener: (name, callback) => { windowEvents[name] = callback; } },
    document: { body: { dataset: {} }, querySelector: get, querySelectorAll: (selector) => selector === '[data-view-panel]' ? panels : [], addEventListener() {} },
    location: { href: 'https://mylaunch.dev/dashboard.html', origin: 'https://mylaunch.dev', search: '?view=project&client=client-one' },
    history: { replaceState() {} }, navigator: { clipboard: { writeText: async () => {} } },
    URL, URLSearchParams, console, setTimeout: (fn) => { sandbox.pendingTimer = fn; return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    FormData: class { constructor(form) { this.data = form.mockData || {}; } *[Symbol.iterator]() { yield* Object.entries(this.data); } }
  };
  vm.runInNewContext(source, sandbox);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const emit = async (selector, event, extra = {}) => get(selector).events[event]?.({ preventDefault() {}, currentTarget: get(selector), ...extra });
  const refresh = async () => { realtime(); await sandbox.pendingTimer(); await new Promise(setImmediate); };
  return { get, calls, emit, refresh, clients, windowEvents };
}

test('project workspace edits contact and progress while preserving payment routes and the client login boundary', () => {
  for (const id of ['project-form', 'project-request-list', 'project-upload', 'project-email-invite', 'project-sync-subscription']) assert.match(markup, new RegExp(`id="${id}"`));
  assert.match(markup, /name="stripeSubscriptionId"/);
  assert.doesNotMatch(markup, /name="supportStatus"|Support access \(manual\)/);
  assert.match(markup, /A copied link alone does not grant access/);
  assert.match(markup, /id="client-send-invite"[^>]*checked/);
  assert.match(markup, /id="payment-form"/);
  assert.match(markup, /js\/portal-data\.js\?v=20261029-admin1/);
});

test('realtime refresh preserves an unsaved project draft', async () => {
  const ui = await setup();
  assert.equal(ui.get('field:business').value, 'AMG');
  ui.get('field:summary').value = 'Unsaved client directions';
  await ui.emit('#project-form', 'input');
  ui.clients[0].summary = 'Remote update';
  await ui.refresh();
  assert.equal(ui.get('field:summary').value, 'Unsaved client directions');
  assert.equal(ui.get('#project-draft-state').textContent, 'Unsaved changes');
  assert.equal(ui.get('#revert-project').disabled, false);
});

test('project save writes the supported fields without manually granting paid access', async () => {
  const ui = await setup();
  ui.get('field:email').value = ' updated@example.com ';
  ui.get('field:stripeSubscriptionId').value = 'sub_example';
  await ui.emit('#project-form', 'input');
  await ui.emit('#project-form', 'submit');
  assert.equal(ui.calls.projects.length, 1);
  assert.equal(ui.calls.projects[0].draft.email, 'updated@example.com');
  assert.equal(ui.calls.projects[0].draft.stripeSubscriptionId, 'sub_example');
  assert.equal('supportStatus' in ui.calls.projects[0].draft, false);
  assert.deepEqual(Object.keys(ui.calls.projects[0].draft).sort(), [...fields, 'milestones'].sort());
  assert.equal(ui.get('#project-draft-state').textContent, 'Saved');
  assert.equal(ui.get('#save-project').disabled, false);
  assert.equal(ui.get('#project-email-invite').disabled, false);
});

test('failed saves keep the draft and restore the editing controls', async () => {
  const ui = await setup({ saveFails: true });
  ui.get('field:summary').value = 'Keep these edits';
  await ui.emit('#project-form', 'input');
  await ui.emit('#project-form', 'submit');
  assert.equal(ui.get('field:summary').value, 'Keep these edits');
  assert.equal(ui.get('#project-draft-state').textContent, 'Unsaved changes');
  assert.equal(ui.get('#project-save-status').textContent, 'Save unavailable');
  assert.equal(ui.get('#project-fields').disabled, false);
});

test('new client invite failure retains the created workspace and offers a retry instead of creating a duplicate', async () => {
  const ui = await setup({ inviteFails: true });
  ui.get('#client-form').mockData = { business: 'New client', contact: 'Alex', email: 'new@example.com', project: 'Website', status: 'active', nextStep: 'Kickoff' };
  ui.get('#client-send-invite').checked = true;
  await ui.emit('#client-form', 'submit', { submitter: { value: 'save' } });
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.invitations.length, 1);
  assert.equal(ui.get('#client-dialog').open, false);
  assert.equal(ui.get('#project-business-name').textContent, 'New client');
  assert.match(ui.get('#project-invite-status').textContent, /Client created, but.*Email rate limit/);
  assert.match(ui.get('#project-portal-url').value, /client-new/);
  await ui.emit('#project-email-invite', 'click');
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.invitations.length, 2);
});

test('new client invitation can be explicitly left unsent', async () => {
  const ui = await setup();
  ui.get('#client-form').mockData = { business: 'New client', contact: 'Alex', email: 'new@example.com', project: 'Website', status: 'active', nextStep: 'Kickoff' };
  ui.get('#client-send-invite').checked = false;
  await ui.emit('#client-form', 'submit', { submitter: { value: 'save' } });
  assert.equal(ui.calls.create.length, 1);
  assert.equal(ui.calls.invitations.length, 0);
  assert.match(ui.get('#project-invite-status').textContent, /when you are ready/);
});

test('invitation cannot go to an old address while an email change is unsaved', async () => {
  const ui = await setup();
  ui.get('field:email').value = 'new-contact@example.com';
  await ui.emit('#project-form', 'input');
  await ui.emit('#project-email-invite', 'click');
  assert.equal(ui.calls.invitations.length, 0);
  assert.match(ui.get('#project-invite-status').textContent, /Save the client email changes/);
});

test('upload validation rejects oversize or unsupported files before an API call', async () => {
  const ui = await setup();
  ui.get('#project-upload').files = [{ name: 'large.pdf', size: 11 * 1024 * 1024 }];
  await ui.emit('#project-upload-form', 'submit');
  assert.match(ui.get('#project-upload-status').textContent, /10 MB/);
  ui.get('#project-upload').files = [{ name: 'script.html', size: 42 }];
  await ui.emit('#project-upload-form', 'submit');
  assert.match(ui.get('#project-upload-status').textContent, /Use PDF/);
  assert.equal(ui.calls.uploads.length, 0);
});

test('Stripe sync requires saved subscription and email changes', async () => {
  const client = { ...fixture(), stripeSubscriptionId: 'sub_saved' };
  const ui = await setup({ clients: [client] });
  ui.get('field:stripeSubscriptionId').value = 'sub_unsaved';
  await ui.emit('#project-sync-subscription', 'click');
  assert.equal(ui.calls.subscriptions.length, 0);
  assert.match(ui.get('#project-subscription-message').textContent, /Save the email and subscription/);
  ui.get('field:stripeSubscriptionId').value = 'sub_saved';
  await ui.emit('#project-sync-subscription', 'click');
  assert.deepEqual(ui.calls.subscriptions, ['client-one']);
});

test('client edit text and filenames render as text, not executable markup', async () => {
  const ui = await setup({ clients: [{ ...fixture(), requests: [{ id: 'request-one', title: '<img src=x onerror=alert(1)>', description: '<script>bad()</script>', pageUrl: 'javascript:alert(1)', status: 'submitted', createdAt: '2026-10-29' }], files: [{ id: 'file-one', filename: '<iframe>.pdf', size: 1234, createdAt: '2026-10-29' }] }] });
  assert.match(ui.get('#project-request-list').innerHTML, /&lt;img/);
  assert.doesNotMatch(ui.get('#project-request-list').innerHTML, /<script>|javascript:/);
  assert.match(ui.get('#project-file-list').innerHTML, /&lt;iframe&gt;/);
});
