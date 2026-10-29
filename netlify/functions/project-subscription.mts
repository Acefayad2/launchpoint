const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || 'https://qqttdbqgyjvdfrkdijai.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = Netlify.env.get('SUPABASE_PUBLISHABLE_KEY') || 'sb_publishable_m_EQAVBgYuO1XXG3R2v_Bg_Qw8nINvS';
const STRIPE_API = 'https://api.stripe.com/v1';
const CLIENT_FIELDS = 'id,contact_email,stripe_subscription_id,subscription_checked_at';
const UNAVAILABLE = 'We couldn’t verify your support subscription right now. Please try again shortly.';

type Project = { id: string; contact_email: string | null; stripe_subscription_id: string | null; subscription_checked_at: string | null };
type SubscriptionAccess = { supportStatus: 'none' | 'active' | 'paused' | 'canceled'; subscriptionStatus: string; checkedAt: string; accessUntil: string | null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

// Every provider operation is bounded; this function never sends a payment mutation to Stripe.
async function providerFetch(url: string, options: RequestInit = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(7000), redirect: 'error' });
}

async function authorizedProject(request: Request, clientId: string): Promise<Project> {
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer \S+$/i.test(authorization) || authorization.length > 16384) throw json({ error: 'Please sign in again.' }, 401);
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY, authorization };
  let userResponse;
  try { userResponse = await providerFetch(`${SUPABASE_URL}/auth/v1/user`, { method: 'GET', headers }); }
  catch { throw json({ error: UNAVAILABLE }, 503); }
  if (userResponse.status === 401 || userResponse.status === 403) throw json({ error: 'Please sign in again.' }, 401);
  if (!userResponse.ok) throw json({ error: UNAVAILABLE }, 503);
  const user = await userResponse.json().catch(() => null);
  if (!user || typeof user.id !== 'string' || !user.id) throw json({ error: 'Please sign in again.' }, 401);

  // This read MUST use the caller JWT, not the service key. RLS decides project ownership/admin access.
  const query = new URLSearchParams({ select: CLIENT_FIELDS, id: `eq.${clientId}`, limit: '1' });
  let response;
  try { response = await providerFetch(`${SUPABASE_URL}/rest/v1/clients?${query}`, { method: 'GET', headers }); }
  catch { throw json({ error: UNAVAILABLE }, 503); }
  if (response.status === 401) throw json({ error: 'Please sign in again.' }, 401);
  if (response.status === 403) throw json({ error: 'This project is not available to your account.' }, 404);
  if (!response.ok) throw json({ error: UNAVAILABLE }, 503);
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== clientId) throw json({ error: 'This project is not available to your account.' }, 404);
  return rows[0];
}

function futurePeriodEnd(subscription: any, now: number) {
  const items = subscription.items?.data;
  let ends: number[] = [];
  if (Array.isArray(items) && items.length && items.some((item) => item?.current_period_end !== undefined)) {
    if (subscription.items.has_more === true || items.some((item) => !Number.isSafeInteger(item?.current_period_end))) return null;
    ends = items.map((item) => item.current_period_end);
  } else if (Number.isSafeInteger(subscription.current_period_end)) ends = [subscription.current_period_end];
  if (!ends.length) return null;
  if (subscription.cancel_at != null) {
    if (!Number.isSafeInteger(subscription.cancel_at)) return null;
    ends.push(subscription.cancel_at);
  }
  const end = Math.min(...ends) * 1000;
  return end > now && end <= 8640000000000000 ? new Date(end).toISOString() : null;
}

function verifiedAccess(subscription: any, project: Project): SubscriptionAccess {
  const now = Date.now();
  const denied: SubscriptionAccess = { supportStatus: 'paused', subscriptionStatus: 'verification_unavailable', checkedAt: new Date(now).toISOString(), accessUntil: null };
  const customer = subscription?.customer;
  const expectedEmail = String(project.contact_email || '').trim().toLowerCase();
  if (!subscription || subscription.id !== project.stripe_subscription_id || subscription.object !== 'subscription'
    || subscription.livemode !== true || !customer || typeof customer !== 'object' || customer.deleted
    || typeof customer.id !== 'string' || !customer.id.startsWith('cus_') || customer.livemode === false
    || !expectedEmail || typeof customer.email !== 'string' || customer.email.trim().toLowerCase() !== expectedEmail) return denied;
  const knownStatuses = ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'];
  if (!knownStatuses.includes(subscription.status)) return denied;
  if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') return { ...denied, supportStatus: 'canceled', subscriptionStatus: subscription.status };
  if (subscription.status !== 'active') return { ...denied, subscriptionStatus: subscription.status };
  if (subscription.pause_collection) return { ...denied, subscriptionStatus: 'paused_collection' };
  const invoice = subscription.latest_invoice;
  // Expansion must succeed. Never infer paid status from subscription.status alone.
  if (!invoice || typeof invoice !== 'object' || invoice.object !== 'invoice' || typeof invoice.id !== 'string'
    || !invoice.id.startsWith('in_') || invoice.livemode !== true) return denied;
  const invoiceCustomer = typeof invoice.customer === 'object' ? invoice.customer?.id : invoice.customer;
  const invoiceSubscriptionValue = invoice.subscription || invoice.parent?.subscription_details?.subscription;
  const invoiceSubscription = typeof invoiceSubscriptionValue === 'object' ? invoiceSubscriptionValue?.id : invoiceSubscriptionValue;
  if (invoiceCustomer !== customer.id || (invoiceSubscription && invoiceSubscription !== subscription.id)) return denied;
  if (invoice.status !== 'paid' || invoice.paid === false) return { ...denied, subscriptionStatus: 'payment_unconfirmed' };
  const accessUntil = futurePeriodEnd(subscription, now);
  if (!accessUntil) return denied;
  return { supportStatus: 'active', subscriptionStatus: 'active', checkedAt: denied.checkedAt, accessUntil };
}

async function storeAccess(project: Project, access: SubscriptionAccess, serviceKey: string) {
  const query = new URLSearchParams({
    id: `eq.${project.id}`,
    stripe_subscription_id: project.stripe_subscription_id == null ? 'is.null' : `eq.${project.stripe_subscription_id}`,
    contact_email: project.contact_email == null ? 'is.null' : `eq.${project.contact_email}`,
    subscription_checked_at: project.subscription_checked_at == null ? 'is.null' : `eq.${project.subscription_checked_at}`,
    select: 'id'
  });
  const headers: Record<string, string> = { apikey: serviceKey, 'content-type': 'application/json', prefer: 'return=representation' };
  // Modern secret keys authenticate through apikey; legacy service-role JWTs also need Authorization.
  if (!serviceKey.startsWith('sb_secret_')) headers.authorization = `Bearer ${serviceKey}`;
  const response = await providerFetch(`${SUPABASE_URL}/rest/v1/clients?${query}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ support_status: access.supportStatus, subscription_status: access.subscriptionStatus,
      subscription_checked_at: access.checkedAt, subscription_access_until: access.accessUntil })
  });
  if (!response.ok) throw json({ error: UNAVAILABLE }, 503);
  const rows = await response.json().catch(() => null);
  if (!Array.isArray(rows)) throw json({ error: UNAVAILABLE }, 503);
  if (rows.length !== 1 || rows[0]?.id !== project.id) throw json({ error: 'This project changed during the subscription check. Refresh and try again.' }, 409);
}

export default async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  try {
    if (Number(request.headers.get('content-length')) > 2048) return json({ error: 'Request is too large.' }, 413);
    const text = await request.text();
    if (text.length > 2048) return json({ error: 'Request is too large.' }, 413);
    let payload;
    try { payload = JSON.parse(text); } catch { return json({ error: 'Send a valid project request.' }, 400); }
    const clientId = payload?.clientId;
    if (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) return json({ error: 'A valid project is required.' }, 400);
    const project = await authorizedProject(request, clientId);
    const serviceKey = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const stripeKey = Netlify.env.get('STRIPE_SECRET_KEY') || '';
    if (!serviceKey) return json({ error: UNAVAILABLE }, 503);
    let access: SubscriptionAccess;
    if (!project.stripe_subscription_id) {
      access = { supportStatus: 'none', subscriptionStatus: 'unlinked', checkedAt: new Date().toISOString(), accessUntil: null };
    } else {
      access = { supportStatus: 'paused', subscriptionStatus: 'verification_unavailable', checkedAt: new Date().toISOString(), accessUntil: null };
      if (stripeKey && /^sub_[A-Za-z0-9]+$/.test(project.stripe_subscription_id)) {
        try {
          const query = new URLSearchParams(); query.append('expand[]', 'customer'); query.append('expand[]', 'latest_invoice');
          const response = await providerFetch(`${STRIPE_API}/subscriptions/${encodeURIComponent(project.stripe_subscription_id)}?${query}`, {
            method: 'GET', headers: { authorization: `Bearer ${stripeKey}` }
          });
          if (response.ok) access = verifiedAccess(await response.json(), project);
        } catch { /* Missing or unavailable provider evidence never grants access. */ }
      }
    }
    await storeAccess(project, access, serviceKey);
    if (access.subscriptionStatus === 'verification_unavailable') return json({ error: UNAVAILABLE }, 503);
    return json(access);
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: UNAVAILABLE }, 503);
  }
};

export const config = {
  path: '/api/project-subscription',
  method: ['POST'],
  rateLimit: { action: 'rate_limit', windowLimit: 30, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
