import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';

const SITE_ORIGIN = 'https://mylaunch.dev';
const QUO_MESSAGES_API = 'https://api.quo.com/v1/messages';
const MAX_BODY_BYTES = 12 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+[1-9]\d{7,14}$/;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UNAVAILABLE = 'Secure sign-in is temporarily unavailable. Please try again shortly.';
type Context = { ip?: string };
type Identity = { userId: string; sessionId: string; emailConfirmed: boolean };
type Settings = { supabaseUrl: string; publicKey: string; serviceKey: string; secret: string };
type RecordValue = Record<string, any>;

function json(body: unknown, status = 200, retryAfter?: number) {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer'
  };
  if (retryAfter) headers['retry-after'] = String(retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

function settings(): Settings {
  const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const secret = Netlify.env.get('ADMIN_AUTH_SECRET') || '';
  if (!serviceKey || secret.length < 32) throw json({ error: UNAVAILABLE }, 503);
  return {
    supabaseUrl: Netlify.env.get('SUPABASE_URL') || 'https://qqttdbqgyjvdfrkdijai.supabase.co',
    publicKey: Netlify.env.get('SUPABASE_PUBLISHABLE_KEY') || 'sb_publishable_m_EQAVBgYuO1XXG3R2v_Bg_Qw8nINvS',
    serviceKey, secret
  };
}

async function providerFetch(url: string, options: RequestInit = {}) {
  return fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(7000) });
}

async function readPayload(request: Request): Promise<RecordValue> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw json({ error: 'Request is too large.' }, 413);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw json({ error: 'Send a JSON request.' }, 415);
  if (!request.body) throw json({ error: 'Send a valid request.' }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw json({ error: 'Request is too large.' }, 413); }
    chunks.push(value);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw json({ error: 'Send a valid request.' }, 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw json({ error: 'Send a valid request.' }, 400);
  return value;
}

async function identity(request: Request, env: Settings): Promise<Identity> {
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer \S+$/i.test(authorization) || authorization.length > 16384) throw json({ error: 'Please sign in again.' }, 401);
  const response = await providerFetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: { apikey: env.publicKey, authorization }
  });
  if (response.status === 401 || response.status === 403) throw json({ error: 'Please sign in again.' }, 401);
  if (!response.ok) throw json({ error: UNAVAILABLE }, 503);
  const user = await response.json().catch(() => null);
  // Decode only AFTER Auth validates this exact bearer. Never trust browser metadata for access.
  let claims;
  try {
    const pieces = authorization.slice(7).split('.');
    if (pieces.length !== 3) throw new Error('Invalid token');
    claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString('utf8'));
  } catch { throw json({ error: 'Please sign in again.' }, 401); }
  if (!user || !claims || typeof claims !== 'object' || !UUID.test(user.id) || claims.sub !== user.id || !UUID.test(claims.session_id)
    || claims.role !== 'authenticated' || user.is_anonymous === true || claims.is_anonymous === true
    || !Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= Date.now()) throw json({ error: 'Please sign in again.' }, 401);
  return { userId: user.id, sessionId: claims.session_id, emailConfirmed: typeof user.email === 'string' && !!user.email && !!user.email_confirmed_at };
}

function rpcError(result: RecordValue): Response {
  const errors: Record<string, [number, string]> = {
    unauthorized_session: [401, 'Please sign in again.'],
    forbidden: [403, 'This account does not have permission for that action.'],
    email_unconfirmed: [403, 'Confirm your email address before continuing.'],
    invalid_invite: [404, 'This setup link is invalid or expired. Ask an administrator for a new link.'],
    invalid_code: [400, 'This code is invalid or expired. Request a new code if needed.'],
    expired_code: [400, 'This code is invalid or expired. Request a new code if needed.'],
    attempts_exhausted: [429, 'Too many attempts. Request a new code after the cooldown.'],
    rate_limited: [429, 'Please wait before requesting another text.'],
    delivery_pending: [409, 'This text is not ready yet. Request a new code shortly.'],
    conflict: [409, 'This account setup changed. Refresh and try again.']
  };
  const [status, error] = errors[result.error] || [503, UNAVAILABLE];
  const retryAfter = status === 429 ? Math.min(3600, Math.max(60, Number(result.retryAfterSeconds) || 60)) : undefined;
  return json({ error, ...(retryAfter ? { retryAfter } : {}) }, status, retryAfter);
}

async function rpc(env: Settings, name: string, body: RecordValue): Promise<RecordValue> {
  const headers: Record<string, string> = { apikey: env.serviceKey, 'content-type': 'application/json' };
  if (!env.serviceKey.startsWith('sb_secret_')) headers.authorization = `Bearer ${env.serviceKey}`;
  const response = await providerFetch(`${env.supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw json({ error: UNAVAILABLE }, 503);
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw json({ error: UNAVAILABLE }, 503);
  if (result.ok !== true) throw rpcError(result);
  return result;
}

function inviteHash(token: unknown) {
  if (typeof token !== 'string' || !INVITE_TOKEN.test(token)) throw json({ error: 'This setup link is invalid or expired. Ask an administrator for a new link.' }, 404);
  return createHash('sha256').update(token).digest('hex');
}

function codeHash(env: Settings, challengeId: string, who: Identity, code: string) {
  return createHmac('sha256', env.secret).update(`${challengeId}:${who.userId}:${who.sessionId}:${code}`).digest('hex');
}

function ipHash(env: Settings, context: Context) {
  // Only Netlify's trusted context, never X-Forwarded-For or another caller-controlled header.
  if (typeof context.ip !== 'string' || !context.ip || context.ip.length > 128) throw json({ error: UNAVAILABLE }, 503);
  return createHmac('sha256', env.secret).update(`ip:${context.ip}`).digest('hex');
}

function phoneMasked(phone: string) { return `••• ••• ${phone.slice(-4)}`; }

function normalizePhone(phone: unknown) {
  if (typeof phone !== 'string' || phone.length > 40) throw json({ error: 'Enter a valid mobile number.' }, 400);
  let cleaned = phone.replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(cleaned)) cleaned = `+1${cleaned}`;
  else if (/^1\d{10}$/.test(cleaned)) cleaned = `+${cleaned}`;
  if (!PHONE.test(cleaned)) throw json({ error: 'Enter a valid mobile number.' }, 400);
  return cleaned;
}

function quoSettings() {
  const key = Netlify.env.get('QUO_API_KEY') || '';
  const from = (Netlify.env.get('QUO_FROM_NUMBER') || '').replace(/[\s().-]/g, '');
  if (!key || !PHONE.test(from)) throw json({ error: UNAVAILABLE }, 503);
  return { key, from };
}

async function sendText(phone: string, content: string, quo: ReturnType<typeof quoSettings>) {
  if (!PHONE.test(phone)) throw json({ error: UNAVAILABLE }, 503);
  const response = await providerFetch(QUO_MESSAGES_API, {
    method: 'POST', headers: { authorization: quo.key, 'content-type': 'application/json' },
    body: JSON.stringify({ content, from: quo.from, to: [phone] })
  });
  const result = await response.json().catch(() => null);
  const messageId = result?.data?.id;
  if (response.status !== 202 || typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(messageId)
    || ['failed', 'undelivered', 'canceled'].includes(result?.data?.status)) throw json({ error: 'We could not send the text. Please try again after the cooldown.' }, 502);
  return messageId;
}

async function cancelQuietly(env: Settings, name: string, body: RecordValue) {
  try { await rpc(env, name, body); } catch { /* Pending records cannot authorize access, even if cleanup fails. */ }
}

export default async (request: Request, context: Context = {}) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    const origin = request.headers.get('origin');
    if (origin !== SITE_ORIGIN || new URL(request.url).origin !== SITE_ORIGIN
      || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'This request must come from LaunchPoint.' }, 403);
    const payload = await readPayload(request);
    const actions = ['invite-info', 'status', 'send-code', 'verify-code', 'revoke', 'invite-create'];
    if (!actions.includes(payload.action)) return json({ error: 'Choose a valid action.' }, 400);
    const env = settings();
    if (payload.action === 'invite-info') {
      const result = await rpc(env, 'admin_auth_invite_info', { p_token_hash: inviteHash(payload.inviteToken) });
      if (typeof result.name !== 'string' || typeof result.phoneMasked !== 'string' || typeof result.expiresAt !== 'string') return json({ error: UNAVAILABLE }, 503);
      return json({ name: result.name, phoneMasked: result.phoneMasked, existingAccount: !!result.existingUserId, expiresAt: result.expiresAt });
    }

    const who = await identity(request, env);
    const actor = { p_user_id: who.userId, p_session_id: who.sessionId };
    if (payload.action === 'status') {
      const result = await rpc(env, 'admin_auth_status', actor);
      if (typeof result.isAdmin !== 'boolean' || typeof result.requiresVerification !== 'boolean' || typeof result.verified !== 'boolean') return json({ error: UNAVAILABLE }, 503);
      return json({ isAdmin: result.isAdmin, requiresVerification: result.requiresVerification, verified: result.verified, phoneMasked: result.phoneMasked || null, expiresAt: result.expiresAt || null });
    }
    if (payload.action === 'revoke') {
      await rpc(env, 'admin_auth_revoke', actor);
      return json({ revoked: true });
    }
    if (payload.action === 'verify-code') {
      if (typeof payload.challengeId !== 'string' || !UUID.test(payload.challengeId) || typeof payload.code !== 'string' || !/^\d{6}$/.test(payload.code)) return json({ error: 'Enter the six-digit code from your text.' }, 400);
      const result = await rpc(env, 'admin_auth_verify_code', { ...actor, p_challenge_id: payload.challengeId, p_code_hash: codeHash(env, payload.challengeId, who, payload.code) });
      if (result.verified !== true || typeof result.expiresAt !== 'string') return json({ error: UNAVAILABLE }, 503);
      return json({ verified: true, expiresAt: result.expiresAt });
    }
    if (payload.action === 'send-code') {
      const tokenHash = payload.inviteToken == null ? null : inviteHash(payload.inviteToken);
      if (tokenHash && !who.emailConfirmed) return json({ error: 'Confirm your email address before continuing.' }, 403);
      const quo = quoSettings();
      const challengeId = randomUUID();
      const code = randomInt(1000000).toString().padStart(6, '0');
      const result = await rpc(env, 'admin_auth_begin_challenge', {
        ...actor, p_invite_hash: tokenHash, p_challenge_id: challengeId,
        p_code_hash: codeHash(env, challengeId, who, code), p_ip_hash: ipHash(env, context)
      });
      try {
        if (typeof result.phone !== 'string' || !PHONE.test(result.phone) || result.challengeId !== challengeId) throw json({ error: UNAVAILABLE }, 503);
        const messageId = await sendText(result.phone, `LaunchPoint verification code: ${code}. Expires in 5 minutes. Never share this code. If you did not request it, ignore this text.`, quo);
        await rpc(env, 'admin_auth_confirm_delivery', { p_challenge_id: challengeId, p_message_id: messageId });
        return json({ challengeId, phoneMasked: phoneMasked(result.phone), retryAfter: 60, expiresIn: 300 });
      } catch (error) {
        await cancelQuietly(env, 'admin_auth_cancel_challenge', { p_challenge_id: challengeId });
        throw error;
      }
    }

    const phone = normalizePhone(payload.phone);
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return json({ error: 'Enter the administrator’s name.' }, 400);
    const existingUserId = payload.existingUserId == null ? null : payload.existingUserId;
    if (existingUserId !== null && (typeof existingUserId !== 'string' || !UUID.test(existingUserId))) return json({ error: 'Choose a valid existing account.' }, 400);
    const quo = quoSettings();
    const token = randomBytes(32).toString('base64url');
    // The service RPC enforces equal-admin authorization, owner bootstrap restrictions and rate limits.
    const result = await rpc(env, 'admin_auth_create_invite', {
      p_actor_id: who.userId, p_actor_session_id: who.sessionId, p_phone: phone, p_name: name,
      p_existing_user_id: existingUserId, p_invite_hash: inviteHash(token)
    });
    if (typeof result.inviteId !== 'string' || !UUID.test(result.inviteId)) return json({ error: UNAVAILABLE }, 503);
    try {
      if (result.phone !== phone || typeof result.expiresAt !== 'string') throw json({ error: UNAVAILABLE }, 503);
      const link = `${SITE_ORIGIN}/admin-setup.html#invite=${token}`;
      const messageId = await sendText(phone, `LaunchPoint: Set up your administrator account: ${link}\nThis private link expires in 48 hours. Do not forward it.`, quo);
      await rpc(env, 'admin_auth_invite_delivery', { p_invite_id: result.inviteId, p_message_id: messageId, p_sent: true });
      return json({ sent: true, deliveryStatus: 'accepted', inviteId: result.inviteId, phoneMasked: phoneMasked(phone), expiresAt: result.expiresAt, messageId });
    } catch (error) {
      await cancelQuietly(env, 'admin_auth_invite_delivery', { p_invite_id: result.inviteId, p_message_id: null, p_sent: false });
      throw error;
    }
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: UNAVAILABLE }, 503);
  }
};

export const config = {
  path: '/api/admin-access', method: ['POST'],
  rateLimit: { action: 'rate_limit', windowLimit: 30, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
