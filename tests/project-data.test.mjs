import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/portal-data.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261029190923_client_project_workspace.sql', import.meta.url), 'utf8');
const clientId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const fixture = (overrides = {}) => ({
  id: clientId, slug: 'test-project', business: 'Test project', contact_email: 'client@example.test',
  status: 'active', support_status: 'none', milestones: [], messages: [], approvals: [], edit_requests: [], project_files: [],
  ...overrides
});
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function boot(options = {}) {
  const calls = { queries: [], rpc: [], uploads: [], removes: [], signed: [], fetch: [], subscriptions: [] };
  const row = options.row === undefined ? fixture() : options.row;
  const session = options.session === undefined ? { access_token: 'test-access-token', user: { id: userId } } : options.session;
  const databaseError = options.databaseError || null;
  function from(table) {
    const call = { table, operation: 'select', filters: [] };
    calls.queries.push(call);
    const result = () => {
      if (table === 'clients') return { data: copy(call.single ? row : row ? [row] : []), error: databaseError };
      if (table === 'edit_requests') return { data: { id: 'request-1', ...copy(call.values), created_at: iso() }, error: options.requestError || null };
      if (table === 'project_files') return { data: call.operation === 'insert'
        ? { id: fileId, ...copy(call.values), created_at: iso() }
        : { storage_path: `${clientId}/${userId}/${fileId}.pdf`, filename: 'verified-file.pdf' },
      error: options.metadataError || null };
      return { data: null, error: null };
    };
    const chain = {
      select(columns) { call.columns = columns; return chain; },
      eq(column, value) { call.filters.push([column, value]); return chain; },
      order() { return chain; },
      insert(values) { call.operation = 'insert'; call.values = values; return chain; },
      update(values) { call.operation = 'update'; call.values = values; return chain; },
      single() { call.single = true; return Promise.resolve(result()); },
      maybeSingle() { call.single = true; return Promise.resolve(result()); },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
    };
    return chain;
  }
  const bucket = {
    async upload(...args) { calls.uploads.push(args); return { error: options.uploadError || null }; },
    async remove(...args) { calls.removes.push(args); return { error: null }; },
    async createSignedUrl(...args) { calls.signed.push(args); return { data: { signedUrl: 'https://storage.example.test/signed?token=limited' }, error: options.signError || null }; }
  };
  const db = {
    auth: { getSession: async () => ({ data: { session }, error: null }) },
    from,
    async rpc(name, params) {
      calls.rpc.push({ name, params });
      return { data: name === 'current_user_role' ? options.role || 'client' : copy(row), error: options.rpcError || null };
    },
    storage: { from(name) { assert.equal(name, 'project-files'); return bucket; } },
    channel(name) {
      const channel = { name, on(event, filter, callback) { calls.subscriptions.push({ event, filter, callback }); return channel; }, subscribe() { return channel; } };
      return channel;
    },
    removeChannel(channel) { calls.removedChannel = channel.name; }
  };
  const sandbox = {
    window: { LAUNCHPOINT_SUPABASE: { url: 'https://project.example.test', publishableKey: 'public-test-key' }, supabase: { createClient: () => db } },
    Date, Intl, URL, crypto: { randomUUID: () => fileId },
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      if (options.fetchError) throw options.fetchError;
      return Response.json(options.syncResult || { supportStatus: 'active', subscriptionStatus: 'active', checkedAt: iso(), accessUntil: iso(86400000) }, { status: options.syncStatus || 200 });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { portal: sandbox.window.LaunchPointPortal, calls };
}

test('project data normalizes requests/files without exposing storage paths', async () => {
  const { portal } = boot({ row: fixture({
    edit_requests: [{ id: 'older', title: 'Old', created_at: iso(-60000) }, { id: 'newer', title: 'New', created_at: iso() }],
    project_files: [{ id: fileId, filename: 'brief.pdf', storage_path: 'private/path', mime_type: 'application/pdf', size: 50, uploaded_by: userId }]
  }) });
  const result = await portal.loadClient('test-project');
  assert.deepEqual(Array.from(result.requests, (item) => item.id), ['newer', 'older']);
  assert.equal(result.files[0].filename, 'brief.pdf');
  assert.equal(result.files[0].uploadedBy, userId);
  assert.equal(JSON.stringify(result).includes('private/path'), false);
});

test('active and waiting builds accept edits without requiring a subscription', async () => {
  for (const status of ['active', 'waiting']) {
    const { portal, calls } = boot({ row: fixture({ status }) });
    assert.equal((await portal.loadClient(clientId)).canSubmitEdits, true);
    await portal.createEditRequest(clientId, { title: '  Change the photo  ', description: '  Use the attached image.  ', pageUrl: 'https://example.test/home' });
    const inserted = calls.queries.find((call) => call.operation === 'insert');
    assert.equal(inserted.table, 'edit_requests');
    assert.equal(inserted.values.created_by, userId);
    assert.equal(inserted.values.client_id, clientId);
    assert.equal(inserted.values.title, 'Change the photo');
    assert.equal(inserted.values.description, 'Use the attached image.');
    assert.equal(calls.fetch.length, 0);
  }
});

test('postlaunch edits require fresh, unexpired paid access; untracked is not a build', async () => {
  for (const changes of [
    { status: 'complete' }, { status: 'untracked' },
    { status: 'complete', support_status: 'active', subscription_checked_at: iso(-660000), subscription_access_until: iso(60000) },
    { status: 'complete', support_status: 'active', subscription_checked_at: iso(), subscription_access_until: iso(-1000) },
    { status: 'complete', support_status: 'paused', subscription_checked_at: iso(), subscription_access_until: iso(60000) }
  ]) {
    const { portal, calls } = boot({ row: fixture(changes) });
    assert.equal((await portal.loadClient(clientId)).canSubmitEdits, false);
    await assert.rejects(portal.createEditRequest(clientId, { title: 'Change', description: 'Details' }), /active, paid support subscription/);
    assert.equal(calls.queries.some((call) => call.operation === 'insert'), false);
  }
  const { portal } = boot({ row: fixture({ status: 'complete', support_status: 'active', subscription_checked_at: iso(), subscription_access_until: iso(60000) }) });
  assert.equal((await portal.loadClient(clientId)).canSubmitEdits, true);
});

test('stale linked subscriptions refresh through the authenticated backend, never caller supplied state', async () => {
  const { portal, calls } = boot({ row: fixture({ status: 'complete', stripe_subscription_id: 'sub_test123', support_status: 'paused', subscription_checked_at: iso(-360000) }) });
  const client = await portal.loadClient(clientId);
  assert.equal(client.canSubmitEdits, true);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, '/api/project-subscription');
  assert.equal(calls.fetch[0].init.headers.Authorization, 'Bearer test-access-token');
  assert.deepEqual(JSON.parse(calls.fetch[0].init.body), { clientId });
});

test('verification failures fail closed while preserving readable project history', async () => {
  const { portal } = boot({ row: fixture({ status: 'complete', stripe_subscription_id: 'sub_test123', support_status: 'active', subscription_checked_at: iso(-360000), subscription_access_until: iso(60000) }), syncStatus: 503, syncResult: { error: 'Verification unavailable' } });
  const client = await portal.loadClient(clientId);
  assert.equal(client.business, 'Test project');
  assert.equal(client.canSubmitEdits, false);
  assert.equal(client.subscriptionStatus, 'verification_unavailable');
});

test('missing clients stay missing and query failures are not mistaken for an empty project', async () => {
  assert.equal(await boot({ row: null }).portal.loadClient(clientId), null);
  await assert.rejects(boot({ databaseError: new Error('Database unavailable') }).portal.loadClient(clientId), /Database unavailable/);
});

test('admin creation and project edits use atomic RPCs, not browser-side partial inserts', async () => {
  const { portal, calls } = boot();
  const input = { business: 'Test project', email: 'client@example.test' };
  await portal.createClient(input);
  await portal.updateProject(clientId, { ...input, milestones: [{ label: 'Build', state: 'current' }] });
  assert.deepEqual(copy(calls.rpc), [
    { name: 'create_project_workspace', params: { p_project: input } },
    { name: 'save_project_workspace', params: { p_client_id: clientId, p_project: input, p_milestones: [{ label: 'Build', state: 'current' }] } }
  ]);
  assert.equal(calls.queries.length, 0);
});

test('request validation rejects executable URLs and status mutation is limited to status', async () => {
  const { portal, calls } = boot({ role: 'admin' });
  for (const pageUrl of ['javascript:alert(1)', 'data:text/html,test', 'not a URL']) {
    await assert.rejects(portal.createEditRequest(clientId, { title: 'Change', description: 'Details', pageUrl }), /full website URL/);
  }
  await assert.rejects(portal.updateEditRequest('request-1', 'paid'), /valid request status/);
  await portal.updateEditRequest('request-1', 'completed');
  const update = calls.queries.find((call) => call.operation === 'update');
  assert.deepEqual(copy(update.values), { status: 'completed' });
  assert.deepEqual(copy(update.filters), [['id', 'request-1']]);
});

test('uploads use a private self-owned path, a size limit, and no overwrites', async () => {
  const { portal, calls } = boot();
  const file = { name: 'brief.pdf', type: 'application/pdf', size: 200 };
  const result = await portal.uploadProjectFile(clientId, file, 'request-1');
  const path = `${clientId}/${userId}/${fileId}.pdf`;
  assert.equal(calls.uploads[0][0], path);
  assert.deepEqual(copy(calls.uploads[0][2]), { contentType: 'application/pdf', upsert: false });
  const insert = calls.queries.find((call) => call.table === 'project_files');
  assert.deepEqual(copy(insert.values), { client_id: clientId, request_id: 'request-1', uploaded_by: userId, storage_path: path, filename: 'brief.pdf', mime_type: 'application/pdf', size: 200 });
  assert.equal(result.id, fileId);
  for (const invalid of [{ name: 'script.html', size: 100 }, { name: 'empty.pdf', size: 0 }, { name: 'huge.pdf', size: 10485761 }]) {
    await assert.rejects(portal.uploadProjectFile(clientId, invalid), /Choose a PDF/);
  }
  assert.equal(calls.uploads.length, 1);
});

test('failed metadata attachment cleans up only the newly uploaded object', async () => {
  const { portal, calls } = boot({ metadataError: new Error('Attachment denied') });
  await assert.rejects(portal.uploadProjectFile(clientId, { name: 'brief.pdf', type: 'application/pdf', size: 50 }), /could not be attached/);
  assert.deepEqual(copy(calls.removes), [[[`${clientId}/${userId}/${fileId}.pdf`]]]);
});

test('central upload validation rejects MIME mismatch before any remote work and allows common ZIP variants', async () => {
  const { portal, calls } = boot();
  await assert.rejects(portal.uploadProjectFile(clientId, { name: 'image.png', type: 'text/html', size: 100 }), /file type does not match/);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.queries.length, 0);
  assert.equal(calls.rpc.length, 0);
  for (const type of ['application/zip', 'application/x-zip-compressed', 'application/x-zip', '']) {
    await portal.uploadProjectFile(clientId, { name: 'reference.zip', type, size: 100 });
  }
  assert.equal(calls.uploads.length, 4);
  for (const upload of calls.uploads) assert.equal(upload[2].contentType, 'application/zip');
});

test('an upload failure does not insert metadata or remove another object', async () => {
  const { portal, calls } = boot({ uploadError: new Error('Upload denied') });
  await assert.rejects(portal.uploadProjectFile(clientId, { name: 'brief.pdf', type: 'application/pdf', size: 50 }), /Upload denied/);
  assert.equal(calls.queries.some((call) => call.table === 'project_files'), false);
  assert.equal(calls.removes.length, 0);
});

test('download signing re-reads the authorized record and ignores caller-supplied paths', async () => {
  const { portal, calls } = boot();
  const url = await portal.getProjectFileUrl({ id: fileId, storage_path: 'another-client/secret.pdf', filename: 'forged.pdf' });
  assert.equal(url, 'https://storage.example.test/signed?token=limited');
  assert.deepEqual(copy(calls.queries[0].filters), [['id', fileId]]);
  assert.deepEqual(copy(calls.signed[0]), [`${clientId}/${userId}/${fileId}.pdf`, 60, { download: 'verified-file.pdf' }]);
});

test('signed-out subscription checks stop before any backend request', async () => {
  const { portal, calls } = boot({ session: null });
  await assert.rejects(portal.syncSubscription(clientId), /sign in again/);
  assert.equal(calls.fetch.length, 0);
});

test('realtime subscriptions are scoped to the selected client and have cleanup', () => {
  const { portal, calls } = boot();
  const unsubscribe = portal.subscribe(clientId, () => {});
  assert.equal(calls.subscriptions.length, 6);
  for (const { filter } of calls.subscriptions) assert.equal(filter.filter, `${filter.table === 'clients' ? 'id' : 'client_id'}=eq.${clientId}`);
  unsubscribe();
  assert.match(calls.removedChannel, /^portal-/);
});

test('migration declares isolated RLS, restricted writes, private files, and transactional admin functions', () => {
  for (const table of ['edit_requests', 'project_files']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
  }
  assert.match(migration, /foreign key \(request_id, client_id\) references public\.edit_requests\(id, client_id\)/);
  assert.match(migration, /grant update\(status\) on public\.edit_requests to authenticated/);
  assert.match(migration, /created_by = \(select auth\.uid\(\)\) and status = 'submitted'/);
  assert.match(migration, /uploaded_by = \(select auth\.uid\(\)\) and private\.can_submit_project_work\(client_id\)/);
  assert.match(migration, /values \('project-files', 'project-files', false, 10485760/);
  assert.match(migration, /subscription_checked_at > now\(\) - interval '10 minutes' and subscription_access_until > now\(\)/);
  assert.match(migration, /returns public\.clients language plpgsql security invoker set search_path = ''/);
  assert.match(migration, /return public\.save_project_workspace\(result\.id/);
  assert.doesNotMatch(migration, /support_status\s*=\s*p_project->>/);
});
