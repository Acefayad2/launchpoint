import test from 'node:test';
import assert from 'node:assert/strict';

const env = { SUPABASE_URL: 'https://project.example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', ANTHROPIC_API_KEY: 'sk-ant-test' };
globalThis.Netlify = { env: { get: (key) => env[key] || '' } };
const { default: analyze, config } = await import('../netlify/functions/analyze-change-request.mts');
const projectId = '550e8400-e29b-41d4-a716-446655440077';
const jpeg = '/9j/' + 'A'.repeat(400);
const body = (overrides = {}) => ({
  clientId: projectId, kind: 'video', duration: '1:42', note: 'Make the Book Now button bigger and swap the top photo.',
  pageUrl: 'https://client.example.com/', frames: [{ data: jpeg, label: 'Frame 1 at 0:10' }, { data: jpeg, label: 'Frame 2 at 0:40' }], ...overrides
});
const request = (payload = body(), headers = {}) => new Request('https://mylaunch.dev/api/analyze-change-request', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-jwt', ...headers }, body: JSON.stringify(payload)
});
const analysis = {
  title: 'Bigger Book Now button and new homepage photo',
  summary: 'Two homepage updates.',
  changes: [
    { location: 'Homepage, top banner', request: 'Make the Book Now button larger.', priority: 'high', reference: 'Frame 1 at 0:10' },
    { location: 'Homepage, top banner', request: 'Replace the banner photo with the new storefront photo.', priority: 'medium', reference: 'Frame 2 at 0:40' }
  ],
  questions: ['Which storefront photo should we use?'],
  confidence: 'high'
};

function mockProviders(t, options = {}) {
  const originalFetch = globalThis.fetch, originalEnv = { ...env };
  const calls = { supabase: [], anthropic: [] };
  t.after(() => { globalThis.fetch = originalFetch; for (const key of Object.keys(env)) delete env[key]; Object.assign(env, originalEnv); });
  if (options.env) Object.assign(env, options.env);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'project.example.supabase.co') {
      calls.supabase.push(url.pathname);
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer client-jwt');
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'client-user' }, { status: options.authStatus || 200 });
      if (url.pathname === '/rest/v1/clients') {
        assert.equal(url.searchParams.get('id'), `eq.${projectId}`);
        return Response.json(options.rows ?? [{ id: projectId, status: 'active', support_status: 'none', subscription_checked_at: null, subscription_access_until: null }]);
      }
    }
    if (url.hostname === 'api.anthropic.com') {
      const sent = JSON.parse(typeof init.body === 'string' ? init.body : await new Response(init.body).text());
      calls.anthropic.push({ url, headers: new Headers(init.headers), body: sent });
      if (options.anthropicStatus) return Response.json({ type: 'error', error: { type: 'api_error', message: 'nope' } }, { status: options.anthropicStatus });
      return Response.json({
        id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: options.refusal ? [] : [{ type: 'text', text: JSON.stringify(options.analysis ?? analysis) }],
        stop_reason: options.refusal ? 'refusal' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 }
      });
    }
    throw new Error(`Unexpected request to ${url}`);
  };
  return calls;
}

test('is a rate-limited POST route', () => {
  assert.equal(config.path, '/api/analyze-change-request');
  assert.deepEqual(config.method, ['POST']);
  assert.equal(config.rateLimit.windowLimit, 10);
});

test('requires a signed-in caller before calling any provider', async (t) => {
  const calls = mockProviders(t);
  const response = await analyze(request(body(), { authorization: '' }));
  assert.equal(response.status, 401);
  assert.equal(calls.anthropic.length, 0);
});

test('rejects non-JPEG frames and too many frames without contacting Supabase or Claude', async (t) => {
  const calls = mockProviders(t);
  assert.equal((await analyze(request(body({ frames: [{ data: 'iVBORw0KGgo=', label: 'png' }] })))).status, 400);
  assert.equal((await analyze(request(body({ frames: Array.from({ length: 11 }, () => ({ data: jpeg })) })))).status, 400);
  assert.equal((await analyze(request(body({ kind: 'photos', frames: Array.from({ length: 7 }, () => ({ data: jpeg })) })))).status, 400);
  assert.equal((await analyze(request(body({ note: 'hi' })))).status, 400);
  assert.equal(calls.supabase.length + calls.anthropic.length, 0);
});

test('closed projects cannot use analysis', async (t) => {
  const calls = mockProviders(t, { rows: [{ id: projectId, status: 'complete', support_status: 'none' }] });
  const response = await analyze(request());
  assert.equal(response.status, 403);
  assert.equal(calls.anthropic.length, 0);
});

test('explains when the Anthropic key has not been added yet', async (t) => {
  const calls = mockProviders(t, { env: { ANTHROPIC_API_KEY: '' } });
  const response = await analyze(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'not_configured');
  assert.equal(calls.anthropic.length, 0);
});

test('sends frames to Claude with structured output and returns a reviewable draft', async (t) => {
  const calls = mockProviders(t);
  const response = await analyze(request());
  assert.equal(response.status, 200);
  const [call] = calls.anthropic;
  assert.equal(call.url.pathname, '/v1/messages');
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.match(call.headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
  assert.equal(call.body.output_config.format.type, 'json_schema');
  const images = call.body.messages[0].content.filter((block) => block.type === 'image');
  assert.equal(images.length, 2);
  assert.equal(images[0].source.media_type, 'image/jpeg');

  const draft = await response.json();
  assert.equal(draft.title, analysis.title);
  assert.match(draft.description, /video itself was not uploaded or stored/);
  assert.match(draft.description, /1\. Homepage, top banner: Make the Book Now button larger\. \(High priority · Frame 1 at 0:10\)/);
  assert.match(draft.description, /To confirm:\n- Which storefront photo/);
  assert.ok(draft.description.length <= 5000);
});

test('a refusal or provider failure falls back to asking for a written request', async (t) => {
  mockProviders(t, { refusal: true });
  assert.equal((await analyze(request())).status, 422);
});

test('provider errors never leak details', async (t) => {
  mockProviders(t, { anthropicStatus: 500 });
  const response = await analyze(request());
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /nope|api_error/);
});
