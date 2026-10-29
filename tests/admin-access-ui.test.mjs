import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const setupSource = await readFile(new URL('../js/admin-setup.js', import.meta.url), 'utf8');
const dashboardSource = await readFile(new URL('../js/dashboard.js', import.meta.url), 'utf8');
const portalSource = await readFile(new URL('../js/portal-data.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../admin-setup.html', import.meta.url), 'utf8');
const accessCss = await readFile(new URL('../css/admin-access.css', import.meta.url), 'utf8');
const studioCss = await readFile(new URL('../css/studio.css', import.meta.url), 'utf8');
const verified = () => ({ isAdmin: true, requiresVerification: true, verified: true, phoneMasked: '••• ••• 0123', expiresAt: new Date(Date.now() + 28_800_000).toISOString() });
const signedIn = () => ({ access_token: 'unit-test-token', user: { id: 'test-owner', email: 'owner@example.com' } });
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

test('admin setup glass card keeps readable inherited text on the dark studio palette', () => {
  const card = accessCss.match(/\.admin-setup-card\s*\{([^}]+)\}/)[1];
  assert.match(card, /color:\s*var\(--ink\)/);
  const fill = card.match(/background:\s*rgb\((\d+) (\d+) (\d+) \/ (\d+)%\)/);
  assert.ok(fill, 'Card needs its dark translucent fill, not a light surface under inherited pale text.');
  const palette = name => studioCss.match(new RegExp(`--${name}:\\s*#([0-9a-f]{6})`))[1].match(/../g).map(value => parseInt(value, 16));
  const alpha = Number(fill[4]) / 100;
  const background = fill.slice(1, 4).map((value, index) => Number(value) * alpha + palette('canvas')[index] * (1 - alpha));
  const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  for (const name of ['ink', 'muted']) assert.ok((luminance(palette(name)) + .05) / (luminance(background) + .05) >= 4.5, `${name} text must meet 4.5:1 contrast.`);
});

async function harness({ dashboard = false, session = signedIn(), status = verified(), invite = { name: 'New admin', phoneMasked: '••• ••• 0124', existingAccount: false }, hash = '', api, signUpResult = { data: { session: null }, error: null }, updateError = null, loadClients } = {}) {
  const nodes = new Map();
  const calls = [];
  const timers = new Map();
  const intervals = new Map();
  const events = {};
  const storage = new Map();
  const urls = [];
  let callback;
  let sequence = 0;
  const state = { session, status };
  function get(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, {
        hidden: true, disabled: false, value: '', textContent: '', innerHTML: '', checked: false, dataset: {}, events: {}, files: [],
        classList: { add: value => classes.add(value), remove: value => classes.delete(value), toggle: (value, force) => force ? classes.add(value) : classes.delete(value) },
        addEventListener(name, cb) { this.events[name] = cb; },
        querySelector: selector => get(`child:${selector}`), querySelectorAll: () => [],
        setAttribute() {}, removeAttribute() {}, focus() {}, checkValidity: () => true,
        reset() { this.resetCalled = true; }, close() { this.open = false; },
        elements: { namedItem: name => get(`field:${name}`) }
      });
    }
    return nodes.get(selector);
  }
  const Portal = {
    getSession: async () => state.session,
    adminAccess: async (action, data = {}) => {
      calls.push({ action, data });
      if (api) { const result = await api(action, data, state); if (result !== undefined) return result; }
      if (action === 'status') return state.status;
      if (action === 'invite-info') return invite;
      if (action === 'send-code') return { challengeId: 'challenge-test', phoneMasked: '••• ••• 0124', retryAfter: 60, expiresIn: 300 };
      if (action === 'verify-code') { state.status = verified(); return { verified: true, expiresAt: state.status.expiresAt }; }
      if (action === 'invite-create') return { sent: true, deliveryStatus: 'accepted', phoneMasked: '••• ••• 0124', expiresAt: new Date(Date.now() + 86400000).toISOString() };
      return {};
    },
    signInWithPassword: async (email, password) => { calls.push({ action: 'password-signin', email, password }); state.session = signedIn(); },
    acceptSignInSession: async session => { state.session = session; },
    signOutAdmin: async () => { calls.push({ action: 'admin-signout' }); state.session = null; callback?.('SIGNED_OUT'); },
    onAuthStateChange: cb => { callback = cb; },
    getRole: async () => { calls.push({ action: 'get-role' }); return 'admin'; },
    loadClients: async () => { calls.push({ action: 'load-clients' }); return loadClients ? loadClients() : []; },
    getPaymentIntegrationStatus: async () => { calls.push({ action: 'load-payments' }); return {}; },
    subscribe: () => { calls.push({ action: 'subscribe' }); return () => calls.push({ action: 'unsubscribe' }); }, initials: () => 'LP', formatTime: () => '',
    db: { auth: {
      signUp: async data => { calls.push({ action: 'signup', data }); return signUpResult; },
      updateUser: async (data, options) => { calls.push({ action: 'update-user', data, options }); return { error: updateError }; },
      signInWithOtp: async data => { calls.push({ action: 'magic-link', data }); return { error: null }; },
      reauthenticate: async () => { calls.push({ action: 'reauthenticate' }); return { error: null }; }
    } }
  };
  const sandbox = {
    window: { LaunchPointPortal: Portal, addEventListener: (name, cb) => { events[name] = cb; } },
    document: { body: { dataset: {} }, querySelector: get, querySelectorAll: () => [], addEventListener: (name, cb) => { events[name] = cb; } },
    location: { href: `https://mylaunch.dev/${dashboard ? 'dashboard' : 'admin-setup'}.html${hash}`, pathname: '/admin-setup.html', search: '', hash, origin: 'https://mylaunch.dev' },
    history: { replaceState: (_, __, url) => urls.push(url) },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    URL, URLSearchParams, console,
    setTimeout: (cb, delay) => { const id = ++sequence; timers.set(id, { cb, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (cb, delay) => { const id = ++sequence; intervals.set(id, { cb, delay }); return id; },
    clearInterval: id => intervals.delete(id)
  };
  vm.runInNewContext(dashboard ? dashboardSource : setupSource, sandbox);
  await settle();
  const emit = async (selector, event, extra = {}) => { await get(selector).events[event]?.({ preventDefault() {}, currentTarget: get(selector), ...extra }); await settle(); };
  return { get, calls, state, storage, urls, events, timers, intervals, sandbox, emit, authEvent: event => callback(event) };
}

test('setup strips only invitation fragment and keeps Supabase auth parameters', async () => {
  const ui = await harness({ session: null, hash: '#invite=opaque-invite&access_token=auth-token&type=signup' });
  assert.equal(ui.storage.get('launchpoint-admin-invite'), 'opaque-invite');
  assert.match(ui.urls[0], /access_token=auth-token/);
  assert.doesNotMatch(ui.urls[0], /invite=/);
  assert.equal(ui.calls.filter(call => call.action === 'send-code').length, 0);
  assert.ok(markup.indexOf('portal-data.js') < markup.indexOf('admin-setup.js'));
  assert.match(markup, /name="referrer" content="no-referrer"/);
});

test('new admin password goes directly to Supabase with token-free email redirect', async () => {
  const ui = await harness({ session: null, hash: '#invite=opaque-invite' });
  ui.get('#setup-email').value = ' NEW@example.com ';
  ui.get('#setup-password').value = 'private-password-123';
  ui.get('#setup-password-confirm').value = 'private-password-123';
  await ui.emit('#setup-auth-form', 'submit');
  const signup = ui.calls.find(call => call.action === 'signup');
  assert.equal(signup.data.email, 'new@example.com');
  assert.equal(signup.data.options.emailRedirectTo, 'https://mylaunch.dev/admin-setup.html');
  assert.equal(ui.calls.some(call => ['send-code', 'verify-code', 'invite-create'].includes(call.action)), false);
  assert.match(ui.get('#setup-status').textContent, /confirm your address/);
  assert.equal(ui.get('#setup-password').value, '');
});

test('new admin rejects short or mismatching passwords before calling auth', async () => {
  const ui = await harness({ session: null, hash: '#invite=opaque-invite' });
  ui.get('#setup-password').value = 'short'; ui.get('#setup-password-confirm').value = 'short';
  await ui.emit('#setup-auth-form', 'submit');
  assert.equal(ui.calls.some(call => call.action === 'signup'), false);
  assert.match(ui.get('#setup-status').textContent, /12 characters/);
});

test('existing owner invitation requires signing in to existing account, not signup', async () => {
  const ui = await harness({ session: null, hash: '#invite=owner-invite', invite: { existingAccount: true, phoneMasked: '••• 0123' } });
  assert.equal(ui.get('#setup-toggle-auth').hidden, true);
  assert.match(ui.get('#setup-auth-copy').textContent, /existing LaunchPoint email/);
  assert.equal(ui.get('#setup-magic-link').hidden, false);
});

test('SMS is explicit, resend is limited, successful verification removes invitation', async () => {
  const ui = await harness({ status: { isAdmin: false, verified: false }, hash: '#invite=opaque-invite' });
  assert.equal(ui.calls.some(call => call.action === 'send-code'), false);
  await ui.emit('#setup-send-code', 'click');
  assert.equal(ui.calls.find(call => call.action === 'send-code').data.inviteToken, 'opaque-invite');
  await ui.emit('#setup-send-code', 'click');
  assert.equal(ui.calls.filter(call => call.action === 'send-code').length, 1);
  ui.get('#setup-code').value = '123456';
  await ui.emit('#setup-code-form', 'submit');
  assert.equal(ui.storage.has('launchpoint-admin-invite'), false);
  assert.equal(ui.get('#setup-code').value, '');
  assert.equal(ui.get('#setup-security').hidden, false);
});

test('legacy admin can invite but must enroll phone before editing credentials', async () => {
  const ui = await harness({ status: { isAdmin: true, verified: true, requiresVerification: false, expiresAt: null } });
  assert.equal(ui.get('#setup-invite').hidden, false);
  assert.equal(ui.get('#setup-security').hidden, true);
  ui.get('#security-password').value = 'private-password-123';
  ui.get('#security-password-confirm').value = 'private-password-123';
  await ui.emit('#setup-security-form', 'submit');
  assert.equal(ui.calls.some(call => call.action === 'update-user'), false);
  assert.match(ui.get('#setup-status').textContent, /Verify your phone/);
});

test('self invitation binds current account UUID; new invite never sets a role or password', async () => {
  const ui = await harness();
  ui.get('#invite-name').value = 'Owner'; ui.get('#invite-phone').value = '(202) 555-0123'; ui.get('#invite-current-account').checked = true;
  await ui.emit('#setup-invite-form', 'submit');
  const call = ui.calls.find(call => call.action === 'invite-create');
  assert.deepEqual(JSON.parse(JSON.stringify(call.data)), { name: 'Owner', phone: '+12025550123', existingUserId: 'test-owner' });
  assert.match(ui.get('#setup-invite-status').textContent, /accepted/);
  assert.doesNotMatch(ui.get('#setup-invite-status').textContent, /opaque|token/);
});

test('invitation success survives browser clearing event.currentTarget after dispatch', async () => {
  const ui = await harness();
  ui.get('#invite-name').value = 'Administrator';
  ui.get('#invite-phone').value = '(202) 555-0124';
  const form = ui.get('#setup-invite-form');
  const event = { preventDefault() {}, currentTarget: form };
  const completed = form.events.submit(event);
  event.currentTarget = null;
  await completed;
  assert.equal(form.resetCalled, true);
  assert.equal(ui.calls.filter(call => call.action === 'invite-create').length, 1);
  assert.match(ui.get('#setup-invite-status').textContent, /Quo accepted/);
});

test('account update requires fresh server verification and preserves direct auth identity', async () => {
  const ui = await harness();
  ui.get('#security-email').value = ' NEW@example.com '; ui.get('#security-password').value = 'private-password-123'; ui.get('#security-password-confirm').value = 'private-password-123';
  await ui.emit('#setup-security-form', 'submit');
  const index = ui.calls.findIndex(call => call.action === 'update-user');
  assert.equal(ui.calls[index - 1].action, 'status');
  assert.equal(ui.calls[index].data.email, 'new@example.com');
  assert.equal(ui.calls[index].options.emailRedirectTo, 'https://mylaunch.dev/admin-setup.html');
  assert.match(ui.get('#setup-status').textContent, /old and new email/);
  assert.equal(ui.get('#security-password').value, '');
});

test('Supabase reauthentication requirement is surfaced without bypassing it', async () => {
  const ui = await harness({ updateError: { message: 'Reauthentication required', code: 'reauthentication_needed' } });
  ui.get('#security-password').value = 'private-password-123'; ui.get('#security-password-confirm').value = 'private-password-123';
  await ui.emit('#setup-security-form', 'submit');
  assert.equal(ui.get('#security-reauth').hidden, false);
  assert.equal(ui.calls.some(call => call.action === 'reauthenticate'), false);
});

test('dashboard phone gate runs before roles, client data, and financial data', async () => {
  const ui = await harness({ dashboard: true, status: { isAdmin: true, verified: false, requiresVerification: true, phoneMasked: '••• 0123' } });
  assert.equal(ui.sandbox.document.body.dataset.authState, 'verification');
  assert.equal(ui.calls.some(call => ['get-role', 'load-clients', 'load-payments', 'send-code'].includes(call.action)), false);
  await ui.emit('#admin-send-code', 'click');
  ui.get('#admin-code').value = '123456'; await ui.emit('#admin-code-form', 'submit');
  assert.equal(ui.sandbox.document.body.dataset.authState, 'ready');
  assert.ok(ui.calls.findIndex(call => call.action === 'verify-code') < ui.calls.findIndex(call => call.action === 'load-clients'));
});

test('dashboard focus check locks expired access and clears rendered client data', async () => {
  const ui = await harness({ dashboard: true });
  ui.get('#message-history').innerHTML = 'private client message'; ui.get('#recent-paid-list').innerHTML = 'private payment';
  ui.state.status = { isAdmin: true, verified: false, requiresVerification: true, phoneMasked: '••• 0123' };
  await ui.events.focus();
  assert.equal(ui.sandbox.document.body.dataset.authState, 'verification');
  assert.equal(ui.get('#message-history').innerHTML, ''); assert.equal(ui.get('#recent-paid-list').innerHTML, '');
});

test('auth callbacks defer async work outside the Supabase lock', async () => {
  const ui = await harness({ dashboard: true });
  const before = ui.calls.length;
  ui.authEvent('TOKEN_REFRESHED');
  assert.equal(ui.calls.length, before);
  assert.ok([...ui.timers.values()].some(timer => timer.delay === 0));
});

test('admin signout revokes lease before native auth signout, including network failure', async () => {
  const calls = [];
  const db = { auth: {
    getSession: async () => ({ data: { session: signedIn() } }),
    signOut: async () => { calls.push('signout'); return {}; }
  } };
  const sandbox = {
    URL,
    window: { LAUNCHPOINT_SUPABASE: { url: 'https://example.supabase.co', publishableKey: 'public' }, supabase: { createClient: () => db } },
    fetch: async (_, options) => { calls.push(JSON.parse(options.body).action); throw new Error('offline'); }
  };
  vm.runInNewContext(portalSource, sandbox);
  await assert.rejects(sandbox.window.LaunchPointPortal.signOutAdmin(), /expire automatically/);
  assert.deepEqual(calls, ['revoke', 'signout']);
});

test('offline native logout removes only app auth keys and blocks cached sessions and late refresh writes', async () => {
  const key = 'sb-example-auth-token';
  const values = new Map([[key, 'old-session'], [`${key}-code-verifier`, 'old-pkce'], [`${key}-user`, 'old-user'], ['unrelated-project', 'preserve-me']]);
  let options;
  let stopped = false;
  let restarted = false;
  let nativeCallback;
  let authEvents = 0;
  let cached = signedIn();
  const db = { auth: {
    getSession: async () => ({ data: { session: cached } }),
    signOut: async () => ({ error: new Error('network unavailable') }),
    stopAutoRefresh: async () => { stopped = true; },
    startAutoRefresh: async () => { restarted = true; },
    signInWithPassword: async () => { cached = { ...signedIn(), access_token: 'new-user-authorized-session' }; return { data: { session: cached } }; },
    onAuthStateChange: callback => { nativeCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; }
  } };
  const sandbox = {
    URL,
    window: {
      LAUNCHPOINT_SUPABASE: { url: 'https://example.supabase.co', publishableKey: 'public' },
      supabase: { createClient: (_, __, config) => { options = config; return db; } },
      localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
    },
    fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(portalSource, sandbox);
  const portal = sandbox.window.LaunchPointPortal;
  portal.onAuthStateChange(() => { authEvents += 1; });
  assert.equal(options.auth.storageKey, key);
  await assert.rejects(portal.signOutAdmin(), /Signed out on this browser/);
  assert.equal(stopped, true);
  assert.equal(await portal.getSession(), null, 'SDK cached first-factor session must not escape local logout');
  assert.deepEqual([...values.entries()], [['unrelated-project', 'preserve-me']]);
  options.auth.storage.setItem(key, 'late-refresh');
  nativeCallback('TOKEN_REFRESHED', signedIn());
  nativeCallback('SIGNED_IN', signedIn());
  assert.equal(values.has(key), false, 'Already-running refresh cannot repersist the revoked session');
  assert.equal(authEvents, 1, 'Only explicit local SIGNED_OUT reached the UI');
  assert.equal(options.auth.storage.getItem(key), null);
  await portal.signInWithPassword('owner@example.com', 'user-entered-secret');
  assert.equal(restarted, true);
  assert.equal((await portal.getSession()).access_token, 'new-user-authorized-session');
  assert.equal(JSON.parse(values.get(key)).access_token, 'new-user-authorized-session');
});

test('logout storage event locks other open tabs and rejects a late cached auth event', async () => {
  let storageListener;
  let nativeCallback;
  const events = [];
  let options;
  const db = { auth: {
    getSession: async () => ({ data: { session: signedIn() } }), stopAutoRefresh: async () => {},
    onAuthStateChange: callback => { nativeCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; }
  } };
  const sandbox = { URL, window: {
    LAUNCHPOINT_SUPABASE: { url: 'https://example.supabase.co', publishableKey: 'public' },
    supabase: { createClient: (_, __, config) => { options = config; return db; } },
    addEventListener: (_, callback) => { storageListener = callback; }
  } };
  vm.runInNewContext(portalSource, sandbox);
  const portal = sandbox.window.LaunchPointPortal;
  portal.onAuthStateChange(event => events.push(event));
  storageListener({ key: 'unrelated-key', newValue: null });
  assert.notEqual(await portal.getSession(), null);
  storageListener({ key: options.auth.storageKey, newValue: null });
  nativeCallback('SIGNED_IN', signedIn());
  assert.equal(await portal.getSession(), null);
  assert.deepEqual(events, ['SIGNED_OUT']);
});

test('expired invitation is discarded so legacy owner can send a replacement', async () => {
  const ui = await harness({ hash: '#invite=expired-invite', status: { isAdmin: true, verified: true, requiresVerification: false }, api: action => {
    if (action === 'invite-info') throw Object.assign(new Error('Invalid invitation'), { status: 404 });
  } });
  assert.equal(ui.storage.has('launchpoint-admin-invite'), false);
  assert.equal(ui.get('#setup-invite').hidden, false);
  assert.match(ui.get('#setup-status').textContent, /expired or was canceled/);
});

test('expired invitation recovers to signin; a provider outage preserves the pending invitation', async () => {
  const expired = await harness({ session: null, hash: '#invite=expired-invite', api: action => {
    if (action === 'invite-info') throw Object.assign(new Error('Invalid invitation'), { status: 404 });
  } });
  assert.equal(expired.storage.has('launchpoint-admin-invite'), false);
  assert.equal(expired.get('#setup-auth').hidden, false);
  assert.match(expired.get('#setup-status').textContent, /fresh invitation/);
  const outage = await harness({ hash: '#invite=still-valid-invite', api: action => {
    if (action === 'invite-info') throw Object.assign(new Error('Temporarily unavailable'), { status: 503 });
  } });
  assert.equal(outage.storage.get('launchpoint-admin-invite'), 'still-valid-invite');
  assert.match(outage.get('#setup-status').textContent, /Temporarily unavailable/);
});

test('dashboard data finishing after logout cannot restart realtime or payment polling', async () => {
  let finishClients;
  const ui = await harness({ dashboard: true, loadClients: () => new Promise(resolve => { finishClients = resolve; }) });
  ui.authEvent('SIGNED_OUT');
  finishClients([]);
  await settle();
  assert.equal(ui.sandbox.document.body.dataset.authState, 'signed-out');
  assert.equal(ui.calls.some(call => call.action === 'subscribe'), false);
  assert.equal(ui.calls.some(call => call.action === 'load-payments'), false);
});
