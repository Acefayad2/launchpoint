const SUPABASE_URL = Netlify.env.get('SUPABASE_URL') || 'https://qqttdbqgyjvdfrkdijai.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = Netlify.env.get('SUPABASE_PUBLISHABLE_KEY') || 'sb_publishable_m_EQAVBgYuO1XXG3R2v_Bg_Qw8nINvS';
const STRIPE_API = 'https://api.stripe.com/v1';
const QUO_MESSAGES_API = 'https://api.quo.com/v1/messages';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

async function requireAdmin(request: Request) {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) throw json({ error: 'Please sign in again.' }, 401);

  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY, authorization };
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers });
  if (!userResponse.ok) throw json({ error: 'Please sign in again.' }, 401);

  const roleResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/current_user_role`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: '{}'
  });
  const role = await roleResponse.json().catch(() => null);
  if (!roleResponse.ok || role !== 'admin') throw json({ error: 'Admin access is required.' }, 403);
}

async function stripeRequest(path: string, secret: string, body: URLSearchParams, idempotencyKey: string) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': idempotencyKey
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe could not create the invoice.');
  return data;
}

async function recentInvoices(secret: string) {
  const invoices: Array<Record<string, unknown>> = [];
  let cursor = '';
  for (let page = 0; page < 3 && invoices.length < 8; page += 1) {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('starting_after', cursor);
    const response = await fetch(`${STRIPE_API}/payment_intents?${params}`, {
      headers: { authorization: `Bearer ${secret}` }
    });
    if (!response.ok) throw new Error('Stripe invoice history is unavailable.');
    const result = await response.json();
    const intents = Array.isArray(result.data) ? result.data : [];
    for (const intent of intents) {
      if (intent.metadata?.launchpoint_invoice !== '1' || !/^pi_[A-Za-z0-9_]+$/.test(intent.id || '')) continue;
      invoices.push({
        id: intent.id,
        reference: intent.metadata.reference || '',
        company: intent.metadata.company || '',
        description: intent.metadata.service_description || '',
        amount: intent.amount,
        status: intent.status,
        created: intent.created,
        sent: intent.metadata.sent_via_quo === '1'
      });
      if (invoices.length === 8) break;
    }
    if (!result.has_more || !intents.length) break;
    cursor = intents[intents.length - 1].id;
  }
  return invoices;
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maximum) : '';
}

function validPhone(value: string) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

export default async (request: Request) => {
  try {
    await requireAdmin(request);

    const stripeSecret = Netlify.env.get('STRIPE_SECRET_KEY') || '';
    const quoApiKey = Netlify.env.get('QUO_API_KEY') || '';
    const quoFromNumber = (Netlify.env.get('QUO_FROM_NUMBER') || '').replace(/[^+\d]/g, '');

    if (request.method === 'GET') {
      const base = { stripeConnected: Boolean(stripeSecret), quoConnected: Boolean(quoApiKey && validPhone(quoFromNumber)) };
      if (!stripeSecret) return json({ ...base, recentInvoices: [] });
      try { return json({ ...base, recentInvoices: await recentInvoices(stripeSecret) }); }
      catch { return json({ ...base, stripeConnected: false, recentInvoices: [], historyError: 'Stripe invoice history could not load.' }); }
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    const payload = await request.json().catch(() => ({}));
    const company = cleanText(payload.company, 100);
    const description = cleanText(payload.description, 120);
    const phone = cleanText(payload.phone, 20).replace(/[^+\d]/g, '');
    const action = payload.action === 'send' ? 'send' : 'generate';
    const amount = Number(payload.amount);
    const amountInCents = Math.round(amount * 100);
    const requestId = /^[a-f0-9-]{36}$/i.test(payload.requestId || '') ? payload.requestId : crypto.randomUUID();

    if (!stripeSecret) return json({ error: 'Stripe is not connected yet. Add STRIPE_SECRET_KEY in Netlify.' }, 503);
    if (!company || !description) return json({ error: 'Company name and payment description are required.' }, 400);
    if (!Number.isFinite(amount) || amountInCents < 100 || amountInCents > 5_000_000) return json({ error: 'Enter an amount between $1 and $50,000.' }, 400);
    if (action === 'send' && !validPhone(phone)) return json({ error: 'Enter the client mobile number with country code, such as +13135550198.' }, 400);
    if (action === 'send' && (!quoApiKey || !validPhone(quoFromNumber))) return json({ error: 'Quo is not connected yet. Add QUO_API_KEY and QUO_FROM_NUMBER in Netlify.' }, 503);

    const reference = `LP-${new Date().getUTCFullYear()}-${requestId.slice(0, 8).toUpperCase()}`;
    const intentBody = new URLSearchParams({
      amount: String(amountInCents),
      currency: 'usd',
      description: `${reference}: ${description}`,
      'automatic_payment_methods[enabled]': 'true',
      'metadata[launchpoint_invoice]': '1',
      'metadata[reference]': reference,
      'metadata[company]': company,
      'metadata[service_description]': description,
      'metadata[request_id]': requestId
    });
    const paymentIntent = await stripeRequest('/payment_intents', stripeSecret, intentBody, `${requestId}-invoice`);
    if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntent.id || '')) throw new Error('Stripe did not return a valid invoice payment.');
    const siteUrl = (Netlify.env.get('URL') || 'https://mylaunch.dev').replace(/\/$/, '');
    const url = `${siteUrl}/invoice/${encodeURIComponent(paymentIntent.id)}`;

    let sent = false;
    if (action === 'send') {
      const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountInCents / 100);
      const quoResponse = await fetch(QUO_MESSAGES_API, {
        method: 'POST',
        headers: { authorization: quoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `LaunchPoint invoice ${reference} for ${company}: ${description}, ${dollars}. Review and pay securely: ${url}`,
          from: quoFromNumber,
          to: [phone]
        })
      });
      if (!quoResponse.ok) {
        const quoError = await quoResponse.json().catch(() => ({}));
        return json({
          error: quoError?.message || quoError?.error || 'The link was created, but Quo could not send the text.',
          url,
          paymentIntentId: paymentIntent.id,
          reference,
          sent: false
        }, 502);
      }
      sent = true;
      try {
        await stripeRequest(`/payment_intents/${encodeURIComponent(paymentIntent.id)}`, stripeSecret,
          new URLSearchParams({ 'metadata[sent_via_quo]': '1' }), `${requestId}-quo-sent`);
      } catch { /* A delivered message must not be reported as failed because status tracking failed. */ }
    }

    return json({ url, paymentIntentId: paymentIntent.id, reference, sent });
  } catch (error) {
    if (error instanceof Response) return error;
    return json({ error: error instanceof Error ? error.message : 'The payment request could not be created.' }, 500);
  }
};

export const config = {
  path: '/api/payment-links',
  method: ['GET', 'POST'],
  rateLimit: { action: 'rate_limit', windowLimit: 30, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
