import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const env = {
  SUPABASE_URL: 'https://project.example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test', ADMIN_AUTH_SECRET: 'test-only-secret-32-bytes-or-longer',
  QUO_API_KEY: 'quo-secret-test', QUO_FROM_NUMBER: '+15551234567'
};
globalThis.Netlify = { env: { get: (key) => env[key] || '' } };
const { default: adminAccess, config } = await import('../netlify/functions/admin-access.mts');
const userId = '550e8400-e29b-41d4-a716-446655440001';
const sessionId = '550e8400-e29b-41d4-a716-446655440002';
const inviteId = '550e8400-e29b-41d4-a716-446655440003';
const challengeId = '550e8400-e29b-41d4-a716-446655440004';
const phone = '+15557654321';
const token = Buffer.alloc(32, 9).toString('base64url');
const context = { ip: '192.0.2.12' };
const expiry = new Date(Date.now() + 8 * 3600000).toISOString();
const jwt = (claims = {}) => ['eyJhbGciOiJFUzI1NiJ9', Buffer.from(JSON.stringify({ sub: userId, session_id: sessionId, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url'), 'signed-by-supabase'].join('.');
const request = (body, headers = {}, url = 'https://mylaunch.dev/api/admin-access') => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://mylaunch.dev', authorization: `Bearer ${jwt()}`, ...headers }, body: JSON.stringify(body)
});
const status = { ok: true, isAdmin: true, requiresVerification: true, verified: false, phoneMasked: '••• ••• 4321', expiresAt: null };

function mockProviders(t, options = {}) {
  const originalFetch = globalThis.fetch, originalEnv = { ...env };
  const calls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, originalEnv);
  });
  Object.assign(env, options.env || {});
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input), body = init.body && JSON.parse(init.body);
    const call = { url, init, body }; calls.push(call);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.redirect, 'error', 'credentials must never follow provider redirects');
    if (url.pathname === '/auth/v1/user') {
      assert.equal(init.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
      assert.match(init.headers.authorization, /^Bearer /);
      if (options.authThrows) throw new Error('private-provider-error');
      return Response.json(options.user ?? { id: userId, email: 'owner@example.test', email_confirmed_at: '2026-10-01T10:00:00Z' }, { status: options.authStatus || 200 });
    }
    if (url.hostname === 'api.quo.com') {
      assert.equal(url.pathname, '/v1/messages'); assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, env.QUO_API_KEY);
      if (options.quoThrows) throw new Error('private-quo-error');
      return Response.json(options.quoBody ?? { data: { id: 'AC_test_123', status: 'queued' } }, { status: options.quoStatus || 202 });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      assert.equal(init.method, 'POST'); assert.equal(init.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY);
      if (env.SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_secret_')) assert.equal(init.headers.authorization, undefined);
      else assert.equal(init.headers.authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
      const name = url.pathname.split('/').pop();
      if (options.rpcThrows === name) throw new Error('private-database-error');
      if (options.rpcStatus?.[name]) return Response.json({ message: 'private-database-error' }, { status: options.rpcStatus[name] });
      if (Object.hasOwn(options.rpc || {}, name)) {
        const value = options.rpc[name];
        return Response.json(typeof value === 'function' ? value(body) : value);
      }
      const defaults = {
        admin_auth_invite_info: { ok: true, name: 'Invited administrator', phoneMasked: '••• ••• 4321', existingUserId: null, expiresAt: expiry },
        admin_auth_status: status,
        admin_auth_begin_challenge: { ok: true, challengeId: body.p_challenge_id, phone, expiresAt: expiry, retryAfterSeconds: 60 },
        admin_auth_confirm_delivery: { ok: true }, admin_auth_cancel_challenge: { ok: true },
        admin_auth_verify_code: { ok: true, verified: true, expiresAt: expiry }, admin_auth_revoke: { ok: true },
        admin_auth_create_invite: { ok: true, inviteId, phone: body.p_phone, expiresAt: expiry },
        admin_auth_invite_delivery: { ok: true }
      };
      assert.ok(Object.hasOwn(defaults, name), `Unexpected RPC ${name}`);
      return Response.json(defaults[name]);
    }
    throw new Error('Unexpected provider');
  };
  return {
    calls, rpcCalls: (name) => calls.filter((call) => call.url.pathname === `/rest/v1/rpc/${name}`),
    quoCalls: () => calls.filter((call) => call.url.hostname === 'api.quo.com')
  };
}

test('admin route is POST-only, same-origin, JSON-only and no-store without CORS', async (t) => {
  const mock = mockProviders(t);
  assert.equal(config.path, '/api/admin-access'); assert.deepEqual(config.method, ['POST']);
  assert.equal((await adminAccess(new Request('https://mylaunch.dev/api/admin-access'))).status, 405);
  for (const headers of [{ origin: 'https://attacker.test' }, { origin: 'null' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await adminAccess(request({ action: 'status' }, headers));
    assert.equal(response.status, 403); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await adminAccess(request({ action: 'status' }, {}, 'https://attacker.test/api/admin-access'))).status, 403);
  assert.equal((await adminAccess(request({ action: 'status' }, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal(mock.calls.length, 0);
});

test('payload byte limit applies with and without Content-Length, including multibyte text', async (t) => {
  const mock = mockProviders(t);
  assert.equal((await adminAccess(request({ action: 'status' }, { 'content-length': '13000' }))).status, 413);
  assert.equal((await adminAccess(request({ action: 'status', junk: 'x'.repeat(13000) }))).status, 413);
  assert.equal((await adminAccess(request({ action: 'status', junk: '☃'.repeat(5000) }))).status, 413);
  assert.equal((await adminAccess(request([]))).status, 400);
  assert.equal((await adminAccess(request({ action: 'unknown' }))).status, 400);
  assert.equal(mock.calls.length, 0);
});

test('missing server secret or service key fails closed before provider access', async (t) => {
  const mock = mockProviders(t, { env: { ADMIN_AUTH_SECRET: 'too-short' } });
  assert.equal((await adminAccess(request({ action: 'status' }))).status, 503);
  env.ADMIN_AUTH_SECRET = 'test-only-secret-32-bytes-or-longer'; env.SUPABASE_SERVICE_ROLE_KEY = '';
  assert.equal((await adminAccess(request({ action: 'status' }))).status, 503);
  assert.equal(mock.calls.length, 0);
});

test('an invitation token is hashed and lookup reveals no account ID, phone, or bearer', async (t) => {
  const mock = mockProviders(t, { rpc: { admin_auth_invite_info: { ok: true, name: 'Owner', phoneMasked: '••• ••• 4321', existingUserId: userId, expiresAt: expiry } } });
  const response = await adminAccess(request({ action: 'invite-info', inviteToken: token }, { authorization: '' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { name: 'Owner', phoneMasked: '••• ••• 4321', existingAccount: true, expiresAt: expiry });
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0].body, { p_token_hash: createHash('sha256').update(token).digest('hex') });
  assert.doesNotMatch(mock.calls[0].init.body, new RegExp(token));
});

test('invalid or expired invitations reveal no records and never send texts', async (t) => {
  const mock = mockProviders(t, { rpc: { admin_auth_invite_info: { ok: false, error: 'invalid_invite' } } });
  assert.equal((await adminAccess(request({ action: 'invite-info', inviteToken: 'guess' }))).status, 404);
  assert.equal(mock.calls.length, 0);
  assert.equal((await adminAccess(request({ action: 'invite-info', inviteToken: token }))).status, 404);
  assert.equal(mock.quoCalls().length, 0);
});

test('authentication rejection never invokes privileged RPCs', async (t) => {
  const mock = mockProviders(t, { authStatus: 401 });
  assert.equal((await adminAccess(request({ action: 'status' }, { authorization: '' }))).status, 401);
  assert.equal(mock.calls.length, 0);
  assert.equal((await adminAccess(request({ action: 'status' }))).status, 401);
  assert.equal(mock.calls.length, 1);
});

test('identity or session mismatch, missing session, expired token and anonymous users fail closed', async (t) => {
  const mock = mockProviders(t);
  for (const claims of [{ sub: inviteId }, { session_id: null }, { session_id: 'not-a-session' }, { exp: 1 }, { role: 'service_role' }, { is_anonymous: true }]) {
    assert.equal((await adminAccess(request({ action: 'status' }, { authorization: `Bearer ${jwt(claims)}` }))).status, 401);
  }
  assert.equal(mock.calls.filter((call) => call.url.pathname.startsWith('/rest/')).length, 0);
});

test('status uses verified auth user and session, not caller user ID or role metadata', async (t) => {
  const mock = mockProviders(t, { user: { id: userId, user_metadata: { role: 'admin' } }, rpc: { admin_auth_status: { ...status, isAdmin: false } } });
  const response = await adminAccess(request({ action: 'status', userId: inviteId, sessionId: inviteId, isAdmin: true }));
  assert.equal(response.status, 200); assert.equal((await response.json()).isAdmin, false);
  assert.deepEqual(mock.rpcCalls('admin_auth_status')[0].body, { p_user_id: userId, p_session_id: sessionId });
});

test('legacy admin status does not fabricate an MFA expiry or require verification', async (t) => {
  mockProviders(t, { rpc: { admin_auth_status: { ...status, verified: true, requiresVerification: false } } });
  const response = await adminAccess(request({ action: 'status' }));
  assert.deepEqual(await response.json(), { isAdmin: true, verified: true, requiresVerification: false, phoneMasked: status.phoneMasked, expiresAt: null });
});

test('send-code uses only stored phone; stores HMAC not code and binds it to verified session', async (t) => {
  const mock = mockProviders(t);
  const response = await adminAccess(request({ action: 'send-code', phone: '+19999999999', userId: inviteId }), context);
  assert.equal(response.status, 200);
  const result = await response.json(), challenge = mock.rpcCalls('admin_auth_begin_challenge')[0].body;
  const sms = mock.quoCalls()[0].body;
  const code = sms.content.match(/code: (\d{6})\./)[1];
  assert.deepEqual(sms.to, [phone]); assert.equal(sms.from, env.QUO_FROM_NUMBER);
  assert.equal(challenge.p_user_id, userId); assert.equal(challenge.p_session_id, sessionId);
  assert.equal(challenge.p_invite_hash, null); assert.equal(challenge.p_challenge_id, result.challengeId);
  assert.equal(challenge.p_code_hash, createHmac('sha256', env.ADMIN_AUTH_SECRET).update(`${result.challengeId}:${userId}:${sessionId}:${code}`).digest('hex'));
  assert.equal(challenge.p_ip_hash, createHmac('sha256', env.ADMIN_AUTH_SECRET).update(`ip:${context.ip}`).digest('hex'));
  assert.deepEqual(mock.rpcCalls('admin_auth_confirm_delivery')[0].body, { p_challenge_id: result.challengeId, p_message_id: 'AC_test_123' });
  assert.deepEqual(result, { challengeId: result.challengeId, phoneMasked: '••• ••• 4321', retryAfter: 60, expiresIn: 300 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${phone.replace('+', '\\+')}|${code}|${env.ADMIN_AUTH_SECRET}`));
  assert.equal(mock.rpcCalls('admin_auth_cancel_challenge').length, 0);
});

test('invitation enrollment requires confirmed email before creating a challenge', async (t) => {
  const mock = mockProviders(t, { user: { id: userId, email: 'notconfirmed@example.test' } });
  assert.equal((await adminAccess(request({ action: 'send-code', inviteToken: token }), context)).status, 403);
  assert.equal(mock.rpcCalls('admin_auth_begin_challenge').length, 0); assert.equal(mock.quoCalls().length, 0);
});

test('invitation challenge hashes the private token before sending it to the database', async (t) => {
  const mock = mockProviders(t);
  assert.equal((await adminAccess(request({ action: 'send-code', inviteToken: token }), context)).status, 200);
  assert.equal(mock.rpcCalls('admin_auth_begin_challenge')[0].body.p_invite_hash, createHash('sha256').update(token).digest('hex'));
  assert.doesNotMatch(mock.rpcCalls('admin_auth_begin_challenge')[0].init.body, new RegExp(token));
});

test('missing trusted IP cannot be bypassed with X-Forwarded-For', async (t) => {
  const mock = mockProviders(t);
  assert.equal((await adminAccess(request({ action: 'send-code' }, { 'x-forwarded-for': '192.0.2.12' }))).status, 503);
  assert.equal(mock.rpcCalls('admin_auth_begin_challenge').length, 0); assert.equal(mock.quoCalls().length, 0);
});

test('missing Quo configuration never creates a sendable challenge or invitation', async (t) => {
  const mock = mockProviders(t, { env: { QUO_API_KEY: '' } });
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 503);
  assert.equal((await adminAccess(request({ action: 'invite-create', name: 'Cudi', phone }))).status, 503);
  assert.equal(mock.rpcCalls('admin_auth_begin_challenge').length, 0);
  assert.equal(mock.rpcCalls('admin_auth_create_invite').length, 0); assert.equal(mock.quoCalls().length, 0);
});

test('malformed challenge target or mismatched challenge ID cannot send a text', async (t) => {
  const options = { rpc: { admin_auth_begin_challenge: (body) => ({ ok: true, phone: 'not-a-phone', challengeId: body.p_challenge_id }) } };
  const mock = mockProviders(t, options);
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 503);
  options.rpc.admin_auth_begin_challenge = { ok: true, phone, challengeId };
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 503);
  assert.equal(mock.rpcCalls('admin_auth_cancel_challenge').length, 2); assert.equal(mock.quoCalls().length, 0);
});

test('atomic database cooldown, phone/IP limits and permission denial stop all outbound SMS', async (t) => {
  const options = { rpc: { admin_auth_begin_challenge: { ok: false, error: 'rate_limited', retryAfterSeconds: 157 } } };
  const mock = mockProviders(t, options);
  const response = await adminAccess(request({ action: 'send-code' }), context);
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '157');
  assert.equal((await response.json()).retryAfter, 157);
  options.rpc.admin_auth_begin_challenge = { ok: false, error: 'forbidden' };
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 403);
  assert.equal(mock.quoCalls().length, 0);
});

test('Quo rejection invalidates pending challenge and never confirms delivery', async (t) => {
  const mock = mockProviders(t, { quoStatus: 429, quoBody: { message: 'private-quo-error', token } });
  const response = await adminAccess(request({ action: 'send-code' }), context);
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /private-quo-error/);
  const id = mock.rpcCalls('admin_auth_begin_challenge')[0].body.p_challenge_id;
  assert.deepEqual(mock.rpcCalls('admin_auth_cancel_challenge')[0].body, { p_challenge_id: id });
  assert.equal(mock.rpcCalls('admin_auth_confirm_delivery').length, 0);
});

test('network failures and malformed provider acceptance fail closed and cancel pending challenge', async (t) => {
  const options = { quoThrows: true };
  const mock = mockProviders(t, options);
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 503);
  options.quoThrows = false; options.quoBody = { data: { status: 'queued' } };
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 502);
  options.quoBody = { data: { id: 'AC_failed', status: 'failed' } };
  assert.equal((await adminAccess(request({ action: 'send-code' }), context)).status, 502);
  assert.equal(mock.rpcCalls('admin_auth_cancel_challenge').length, 3);
  assert.equal(mock.rpcCalls('admin_auth_confirm_delivery').length, 0);
});

test('delivery marker failure cancels the challenge and reveals no successful verification', async (t) => {
  const mock = mockProviders(t, { rpcThrows: 'admin_auth_confirm_delivery' });
  const response = await adminAccess(request({ action: 'send-code' }), context);
  assert.equal(response.status, 503); assert.equal(mock.rpcCalls('admin_auth_cancel_challenge').length, 1);
  assert.doesNotMatch(await response.text(), /private-database-error|challengeId/);
});

test('verify-code rejects malformed input before DB and binds supplied code to caller session', async (t) => {
  const mock = mockProviders(t);
  assert.equal((await adminAccess(request({ action: 'verify-code', challengeId, code: '123' }))).status, 400);
  assert.equal((await adminAccess(request({ action: 'verify-code', challengeId, code: 123456 }))).status, 400);
  assert.equal(mock.rpcCalls('admin_auth_verify_code').length, 0);
  const response = await adminAccess(request({ action: 'verify-code', challengeId, code: '001234', userId: inviteId }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { verified: true, expiresAt: expiry });
  assert.deepEqual(mock.rpcCalls('admin_auth_verify_code')[0].body, {
    p_user_id: userId, p_session_id: sessionId, p_challenge_id: challengeId,
    p_code_hash: createHmac('sha256', env.ADMIN_AUTH_SECRET).update(`${challengeId}:${userId}:${sessionId}:001234`).digest('hex')
  });
});

test('expired, reused, wrong-user and exhausted codes never fabricate a verified session', async (t) => {
  const options = { rpc: { admin_auth_verify_code: { ok: false, error: 'invalid_code' } } };
  mockProviders(t, options);
  for (const [error, expected] of [['invalid_code', 400], ['expired_code', 400], ['attempts_exhausted', 429], ['delivery_pending', 409], ['unauthorized_session', 401]]) {
    options.rpc.admin_auth_verify_code = { ok: false, error };
    const response = await adminAccess(request({ action: 'verify-code', challengeId, code: '123456' }));
    assert.equal(response.status, expected); assert.doesNotMatch(await response.text(), /"verified":true/);
  }
});

test('revocation is restricted to authenticated caller session', async (t) => {
  const mock = mockProviders(t);
  const response = await adminAccess(request({ action: 'revoke', userId: inviteId, sessionId: inviteId }));
  assert.deepEqual(await response.json(), { revoked: true });
  assert.deepEqual(mock.rpcCalls('admin_auth_revoke')[0].body, { p_user_id: userId, p_session_id: sessionId });
});

test('equal-admin invitations require database permission before SMS and accept no caller role', async (t) => {
  const mock = mockProviders(t, { rpc: { admin_auth_create_invite: { ok: false, error: 'forbidden' } } });
  const response = await adminAccess(request({ action: 'invite-create', name: 'Cudi', phone, isAdmin: true, role: 'admin' }));
  assert.equal(response.status, 403); assert.equal(mock.quoCalls().length, 0);
  const body = mock.rpcCalls('admin_auth_create_invite')[0].body;
  assert.equal(body.p_actor_id, userId); assert.equal(body.p_actor_session_id, sessionId);
  assert.equal(body.role, undefined); assert.equal(body.isAdmin, undefined);
});

test('invitation sends a 256-bit fragment token only to approved number, never to caller', async (t) => {
  const mock = mockProviders(t);
  const response = await adminAccess(request({ action: 'invite-create', name: 'Cudi', phone: '(555) 765-4321', existingUserId: userId }));
  assert.equal(response.status, 200);
  const result = await response.json(), creation = mock.rpcCalls('admin_auth_create_invite')[0].body;
  const sms = mock.quoCalls()[0].body;
  const setupToken = sms.content.match(/https:\/\/mylaunch\.dev\/admin-setup\.html#invite=([\w-]{43})/)[1];
  assert.equal(Buffer.from(setupToken, 'base64url').byteLength, 32);
  assert.deepEqual(sms.to, [phone]); assert.equal(creation.p_phone, phone);
  assert.equal(creation.p_existing_user_id, userId); assert.equal(creation.p_name, 'Cudi');
  assert.equal(creation.p_invite_hash, createHash('sha256').update(setupToken).digest('hex'));
  assert.deepEqual(result, { sent: true, deliveryStatus: 'accepted', inviteId, phoneMasked: '••• ••• 4321', expiresAt: expiry, messageId: 'AC_test_123' });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${setupToken}|${userId}|https:|${phone.replace('+', '\\+')}`));
  assert.deepEqual(mock.rpcCalls('admin_auth_invite_delivery')[0].body, { p_invite_id: inviteId, p_message_id: 'AC_test_123', p_sent: true });
});

test('failed invite send invalidates invitation and never returns raw token', async (t) => {
  const mock = mockProviders(t, { quoStatus: 403 });
  const response = await adminAccess(request({ action: 'invite-create', name: 'Cudi', phone }));
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /invite=|https:/);
  assert.deepEqual(mock.rpcCalls('admin_auth_invite_delivery')[0].body, { p_invite_id: inviteId, p_message_id: null, p_sent: false });
});

test('invite payload validation prevents SMS and malformed phone/name/account targets', async (t) => {
  const mock = mockProviders(t);
  for (const fields of [{ phone: 'call-anyone' }, { name: 'Hello\nInjected' }, { name: '' }, { existingUserId: 'not-a-uuid' }]) {
    assert.equal((await adminAccess(request({ action: 'invite-create', name: 'Cudi', phone, ...fields }))).status, 400);
  }
  assert.equal(mock.rpcCalls('admin_auth_create_invite').length, 0); assert.equal(mock.quoCalls().length, 0);
});

test('modern Supabase secret keys never get forwarded as Bearer authorization', async (t) => {
  const mock = mockProviders(t, { env: { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_private-test' } });
  assert.equal((await adminAccess(request({ action: 'status' }))).status, 200);
  assert.equal(mock.rpcCalls('admin_auth_status')[0].init.headers.authorization, undefined);
});

test('provider, database and malformed-success errors expose no internals and fail closed', async (t) => {
  const options = { authThrows: true, rpc: {} };
  const mock = mockProviders(t, options);
  let response = await adminAccess(request({ action: 'status' }));
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-provider/);
  options.authThrows = false; options.rpc.admin_auth_status = { ok: false, error: 'private-database-error', token };
  response = await adminAccess(request({ action: 'status' }));
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-database/);
  options.rpc.admin_auth_status = { ok: true, isAdmin: 'yes', verified: 'yes' };
  assert.equal((await adminAccess(request({ action: 'status' }))).status, 503);
  assert.equal(mock.quoCalls().length, 0);
});
