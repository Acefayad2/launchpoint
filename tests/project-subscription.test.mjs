import test from 'node:test';
import assert from 'node:assert/strict';

const env = { SUPABASE_URL: 'https://project.example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', STRIPE_SECRET_KEY: 'rk_live_test' };
globalThis.Netlify = { env: { get: (key) => env[key] || '' } };
const { default: checkSubscription, config } = await import('../netlify/functions/project-subscription.mts');
const projectId = '550e8400-e29b-41d4-a716-446655440066';
const subscriptionId = 'sub_Live123';
const customerId = 'cus_Client123';
const projectFixture = (overrides = {}) => ({ id: projectId, contact_email: 'client@example.test', stripe_subscription_id: subscriptionId, subscription_checked_at: null, ...overrides });
const subscriptionFixture = (overrides = {}) => ({
  object: 'subscription', id: subscriptionId, livemode: true, status: 'active', pause_collection: null,
  customer: { object: 'customer', id: customerId, email: 'client@example.test', livemode: true },
  latest_invoice: { object: 'invoice', id: 'in_Paid123', livemode: true, status: 'paid', paid: true, customer: customerId, parent: { subscription_details: { subscription: subscriptionId } } },
  items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30 }], has_more: false },
  ...overrides
});
const request = (body = { clientId: projectId }, headers = {}) => new Request('https://mylaunch.dev/api/project-subscription', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-jwt', ...headers }, body: JSON.stringify(body)
});

function mockProviders(t, options = {}) {
  const originalFetch = globalThis.fetch, originalEnv = { ...env };
  const project = projectFixture(options.project), subscription = subscriptionFixture(options.subscription);
  const calls = [];
  t.after(() => { globalThis.fetch = originalFetch; for (const key of Object.keys(env)) delete env[key]; Object.assign(env, originalEnv); });
  if (options.env) Object.assign(env, options.env);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input); const call = { url, init }; calls.push(call);
    assert.ok(init.signal instanceof AbortSignal, 'every outbound provider request must have a timeout');
    assert.equal(init.redirect, 'error', 'never forward authorization to redirect targets');
    if (url.pathname === '/auth/v1/user') {
      if (options.authThrows) throw new DOMException('secret provider details', 'TimeoutError');
      return Response.json(options.authBody ?? { id: 'authenticated-user' }, { status: options.authStatus || 200 });
    }
    if (url.pathname === '/rest/v1/clients' && init.method === 'GET') {
      if (options.readThrows) throw new DOMException('secret provider details', 'TimeoutError');
      assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
      assert.equal(init.headers.authorization, 'Bearer client-jwt');
      assert.equal(url.searchParams.get('id'), `eq.${projectId}`);
      assert.equal(url.searchParams.get('limit'), '1');
      return Response.json(options.rows ?? [project], { status: options.readStatus || 200 });
    }
    if (url.hostname === 'api.stripe.com') {
      assert.equal(init.method, 'GET', 'Stripe must never receive a mutation');
      assert.equal(url.pathname, `/v1/subscriptions/${subscriptionId}`);
      assert.deepEqual(url.searchParams.getAll('expand[]'), ['customer', 'latest_invoice']);
      assert.equal(init.headers.authorization, `Bearer ${env.STRIPE_SECRET_KEY}`);
      assert.equal(init.body, undefined);
      if (options.stripeThrows) throw new DOMException('upstream secret details', 'TimeoutError');
      if (options.stripeMalformed) return new Response('{broken');
      return Response.json(options.stripeBody ?? subscription, { status: options.stripeStatus || 200 });
    }
    if (url.pathname === '/rest/v1/clients' && init.method === 'PATCH') {
      assert.equal(init.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
      assert.notEqual(init.headers.authorization, 'Bearer client-jwt');
      assert.equal(init.headers.prefer, 'return=representation');
      if (options.patchThrows) throw new DOMException('private db details', 'TimeoutError');
      return Response.json(options.patchRows ?? [{ id: project.id }], { status: options.patchStatus || 200 });
    }
    throw new Error('Unexpected provider request');
  };
  return {
    calls, project, subscription,
    patches: () => calls.filter((call) => call.init.method === 'PATCH'),
    patch: () => { const call = calls.find((item) => item.init.method === 'PATCH'); return call && JSON.parse(call.init.body); },
    stripeCalls: () => calls.filter((call) => call.url.hostname === 'api.stripe.com')
  };
}

test('subscription route is POST-only and invalid payloads do not reach providers', async (t) => {
  const mock = mockProviders(t);
  assert.equal(config.path, '/api/project-subscription'); assert.deepEqual(config.method, ['POST']);
  assert.equal((await checkSubscription(new Request('https://mylaunch.dev/api/project-subscription'))).status, 405);
  assert.equal((await checkSubscription(request({ clientId: 'different-project' }))).status, 400);
  assert.equal((await checkSubscription(new Request('https://mylaunch.dev/api/project-subscription', { method: 'POST', body: '{bad' }))).status, 400);
  assert.equal((await checkSubscription(request({ clientId: projectId, extra: 'x'.repeat(2100) }))).status, 413);
  assert.equal(mock.calls.length, 0);
});

test('missing or invalid authorization never reads a client or reaches Stripe', async (t) => {
  const mock = mockProviders(t, { authStatus: 401 });
  assert.equal((await checkSubscription(request(undefined, { authorization: '' }))).status, 401);
  assert.equal(mock.calls.length, 0);
  assert.equal((await checkSubscription(request())).status, 401);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.patches().length, 0);
});

test('valid HTTP response without a verified user does not authorize access', async (t) => {
  const mock = mockProviders(t, { authBody: {} });
  assert.equal((await checkSubscription(request())).status, 401);
  assert.equal(mock.calls.length, 1);
});

test('auth provider outage returns generic 503 and never uses service access', async (t) => {
  const mock = mockProviders(t, { authThrows: true });
  const result = await checkSubscription(request());
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /secret provider/);
  assert.equal(mock.calls.length, 1);
});

test('caller RLS ownership denial prevents Stripe reads and privileged writes', async (t) => {
  const mock = mockProviders(t, { rows: [] });
  assert.equal((await checkSubscription(request())).status, 404);
  assert.equal(mock.calls.length, 2); assert.equal(mock.stripeCalls().length, 0); assert.equal(mock.patches().length, 0);
});

test('RLS response for another client is rejected', async (t) => {
  const mock = mockProviders(t, { rows: [projectFixture({ id: '550e8400-e29b-41d4-a716-446655440077' })] });
  assert.equal((await checkSubscription(request())).status, 404);
  assert.equal(mock.patches().length, 0);
});

test('active live subscription with paid invoice grants bounded project access after caller RLS', async (t) => {
  const mock = mockProviders(t);
  const response = await checkSubscription(request({ clientId: projectId, stripeSubscriptionId: 'sub_Attacker', email: 'attacker@example.test', paid: true }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.supportStatus, 'active'); assert.equal(result.subscriptionStatus, 'active');
  assert.ok(Date.now() - Date.parse(result.checkedAt) < 1000);
  assert.equal(Date.parse(result.accessUntil), mock.subscription.items.data[0].current_period_end * 1000);
  assert.deepEqual(mock.patch(), { support_status: 'active', subscription_status: 'active', subscription_checked_at: result.checkedAt, subscription_access_until: result.accessUntil });
  assert.deepEqual(mock.calls.map((call) => call.init.method), ['GET', 'GET', 'GET', 'PATCH']);
  assert.equal(mock.stripeCalls().length, 1);
  assert.doesNotMatch(JSON.stringify(result), /client-jwt|service-role|rk_live|customer|email/);
});

test('customer email matching trims and ignores case', async (t) => {
  const mock = mockProviders(t, { project: { contact_email: ' CLIENT@Example.Test ' } });
  assert.equal((await checkSubscription(request())).status, 200);
  assert.equal(mock.patch().support_status, 'active');
  assert.equal(mock.patches()[0].url.searchParams.get('contact_email'), 'eq. CLIENT@Example.Test ');
});

test('legacy top-level billing period is accepted', async (t) => {
  const end = Math.floor(Date.now() / 1000) + 3600;
  const mock = mockProviders(t, { subscription: { items: { data: [{ id: 'si_legacy' }] }, current_period_end: end } });
  const response = await checkSubscription(request()); assert.equal(response.status, 200);
  assert.equal(Date.parse((await response.json()).accessUntil), end * 1000);
  assert.equal(mock.patch().support_status, 'active');
});

test('paid invoice status remains supported when Stripe omits the legacy paid boolean', async (t) => {
  const invoice = { ...subscriptionFixture().latest_invoice, parent: { subscription_details: { subscription: { id: subscriptionId } } } };
  delete invoice.paid;
  const mock = mockProviders(t, { subscription: { latest_invoice: invoice } });
  assert.equal((await checkSubscription(request())).status, 200);
  assert.equal(mock.patch().support_status, 'active');
});

test('malformed stored subscription ID cannot select a different Stripe endpoint', async (t) => {
  const mock = mockProviders(t, { project: { stripe_subscription_id: '../payment_intents' } });
  assert.equal((await checkSubscription(request())).status, 503);
  assert.equal(mock.stripeCalls().length, 0); assert.equal(mock.patch().subscription_access_until, null);
});

test('multi-item billing periods use the earliest end and an earlier scheduled cancellation', async (t) => {
  const now = Math.floor(Date.now() / 1000), end = now + 1800;
  mockProviders(t, { subscription: { items: { data: [{ current_period_end: now + 86400 }, { current_period_end: now + 3600 }], has_more: false }, cancel_at: end, cancel_at_period_end: true } });
  const response = await checkSubscription(request()); assert.equal(response.status, 200);
  assert.equal(Date.parse((await response.json()).accessUntil), end * 1000);
});

test('canceled subscriptions close support even when the old invoice was paid', async (t) => {
  const mock = mockProviders(t, { subscription: { status: 'canceled' } });
  const response = await checkSubscription(request()); assert.equal(response.status, 200);
  assert.equal((await response.json()).supportStatus, 'canceled'); assert.equal(mock.patch().subscription_access_until, null);
});

for (const stripeStatus of ['trialing', 'incomplete', 'past_due', 'unpaid', 'paused']) {
  test(`${stripeStatus} does not grant ongoing edit access`, async (t) => {
    const mock = mockProviders(t, { subscription: { status: stripeStatus } });
    const response = await checkSubscription(request()); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.supportStatus, 'paused'); assert.equal(result.subscriptionStatus, stripeStatus);
    assert.equal(mock.patch().subscription_access_until, null);
  });
}

test('paused collection does not grant access even if Stripe status remains active', async (t) => {
  const mock = mockProviders(t, { subscription: { pause_collection: { behavior: 'void' } } });
  const response = await checkSubscription(request()); assert.equal(response.status, 200);
  assert.equal((await response.json()).subscriptionStatus, 'paused_collection'); assert.equal(mock.patch().support_status, 'paused');
});

test('active subscription with an unpaid latest invoice remains paused', async (t) => {
  const invoice = { ...subscriptionFixture().latest_invoice, paid: false, status: 'open' };
  const mock = mockProviders(t, { subscription: { latest_invoice: invoice } });
  const response = await checkSubscription(request()); assert.equal(response.status, 200);
  assert.equal((await response.json()).subscriptionStatus, 'payment_unconfirmed'); assert.equal(mock.patch().subscription_access_until, null);
});

for (const [name, subscription] of [
  ['a test-mode subscription', { livemode: false }],
  ['a different subscription id', { id: 'sub_Different' }],
  ['a mismatched customer email', { customer: { id: customerId, email: 'someone-else@example.test' } }],
  ['a missing expanded customer', { customer: customerId }],
  ['a deleted customer', { customer: { id: customerId, email: 'client@example.test', deleted: true } }],
  ['a missing expanded invoice', { latest_invoice: 'in_NotExpanded' }],
  ['a test-mode invoice', { latest_invoice: { ...subscriptionFixture().latest_invoice, livemode: false } }],
  ['an invoice for another customer', { latest_invoice: { ...subscriptionFixture().latest_invoice, customer: 'cus_Different' } }],
  ['an invoice for another subscription', { latest_invoice: { ...subscriptionFixture().latest_invoice, subscription: 'sub_Different' } }],
  ['an expired billing period', { items: { data: [{ current_period_end: 1 }] } }],
  ['a missing billing period', { items: { data: [] } }],
  ['a partially paginated item collection', { items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 3600 }], has_more: true } }],
  ['an unknown subscription state', { status: 'unexpected_state' }]
]) {
  test(`${name} invalidates access and returns only a generic error`, async (t) => {
    const mock = mockProviders(t, { subscription }); const response = await checkSubscription(request());
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()), ['error']);
    assert.equal(mock.patch().support_status, 'paused'); assert.equal(mock.patch().subscription_status, 'verification_unavailable');
    assert.equal(mock.patch().subscription_access_until, null);
  });
}

for (const [name, options] of [['timeout', { stripeThrows: true }], ['HTTP error', { stripeStatus: 500, stripeBody: { error: { message: 'PRIVATE token is secret' } } }], ['malformed JSON', { stripeMalformed: true }]]) {
  test(`Stripe ${name} invalidates existing access without exposing provider detail`, async (t) => {
    const mock = mockProviders(t, options); const response = await checkSubscription(request());
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|secret|upstream/);
    assert.equal(mock.patch().support_status, 'paused'); assert.equal(mock.patch().subscription_access_until, null);
  });
}

test('cache update is conditional on original subscription, email, and checked timestamp', async (t) => {
  const prior = '2026-10-28T12:00:00.000Z'; const mock = mockProviders(t, { project: { subscription_checked_at: prior } });
  assert.equal((await checkSubscription(request())).status, 200);
  const query = mock.patches()[0].url.searchParams;
  assert.equal(query.get('id'), `eq.${projectId}`); assert.equal(query.get('stripe_subscription_id'), `eq.${subscriptionId}`);
  assert.equal(query.get('contact_email'), 'eq.client@example.test'); assert.equal(query.get('subscription_checked_at'), `eq.${prior}`);
});

test('concurrent project changes return 409 instead of granting access from stale evidence', async (t) => {
  const mock = mockProviders(t, { patchRows: [] }); const response = await checkSubscription(request());
  assert.equal(response.status, 409); assert.match((await response.json()).error, /project changed/);
  assert.equal(mock.patches()[0].url.searchParams.get('subscription_checked_at'), 'is.null');
});

test('database write failure cannot return verified access', async (t) => {
  mockProviders(t, { patchThrows: true }); const response = await checkSubscription(request());
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private db/);
});

test('missing service-role configuration fails without Stripe or cache mutation', async (t) => {
  const mock = mockProviders(t, { env: { SUPABASE_SERVICE_ROLE_KEY: '' } });
  assert.equal((await checkSubscription(request())).status, 503);
  assert.equal(mock.stripeCalls().length, 0); assert.equal(mock.patches().length, 0);
});

test('missing Stripe configuration invalidates cache rather than trusting old access', async (t) => {
  const mock = mockProviders(t, { env: { STRIPE_SECRET_KEY: '' } });
  assert.equal((await checkSubscription(request())).status, 503);
  assert.equal(mock.stripeCalls().length, 0); assert.equal(mock.patch().subscription_access_until, null);
});

test('an unlinked project returns no support access without querying Stripe', async (t) => {
  const mock = mockProviders(t, { project: { stripe_subscription_id: null } });
  const response = await checkSubscription(request()); assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.supportStatus, 'none'); assert.equal(result.subscriptionStatus, 'unlinked'); assert.equal(result.accessUntil, null);
  assert.equal(mock.stripeCalls().length, 0); assert.equal(mock.patches()[0].url.searchParams.get('stripe_subscription_id'), 'is.null');
});

test('modern Supabase secret key is sent only as apikey on cache write', async (t) => {
  const mock = mockProviders(t, { env: { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' } });
  assert.equal((await checkSubscription(request())).status, 200);
  assert.equal(mock.patches()[0].init.headers.authorization, undefined);
  assert.equal(mock.patches()[0].init.headers.apikey, 'sb_secret_test');
});
