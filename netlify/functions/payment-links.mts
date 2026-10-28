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
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe could not create the payment link.');
  return data;
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
      return json({ stripeConnected: Boolean(stripeSecret), quoConnected: Boolean(quoApiKey && validPhone(quoFromNumber)) });
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

    const productBody = new URLSearchParams({
      name: `LaunchPoint — ${description}`.slice(0, 127),
      description: `Payment for ${company}`.slice(0, 500),
      'metadata[company]': company,
      'metadata[request_id]': requestId
    });
    const product = await stripeRequest('/products', stripeSecret, productBody, `${requestId}-product`);

    const priceBody = new URLSearchParams({
      currency: 'usd',
      unit_amount: String(amountInCents),
      product: product.id,
      'metadata[company]': company,
      'metadata[request_id]': requestId
    });
    const price = await stripeRequest('/prices', stripeSecret, priceBody, `${requestId}-price`);

    const siteUrl = (Netlify.env.get('URL') || 'https://mylaunch.dev').replace(/\/$/, '');
    const linkBody = new URLSearchParams({
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': '1',
      'restrictions[completed_sessions][limit]': '1',
      'after_completion[type]': 'redirect',
      'after_completion[redirect][url]': `${siteUrl}/payment-success.html`,
      'payment_intent_data[description]': `${company} — ${description}`.slice(0, 500),
      'payment_intent_data[metadata][company]': company,
      'payment_intent_data[metadata][request_id]': requestId,
      'metadata[company]': company,
      'metadata[request_id]': requestId
    });
    const paymentLink = await stripeRequest('/payment_links', stripeSecret, linkBody, `${requestId}-link`);

    let sent = false;
    if (action === 'send') {
      const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountInCents / 100);
      const quoResponse = await fetch(QUO_MESSAGES_API, {
        method: 'POST',
        headers: { authorization: quoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `LaunchPoint payment request for ${description}: ${dollars}. Pay securely here: ${paymentLink.url}`,
          from: quoFromNumber,
          to: [phone]
        })
      });
      if (!quoResponse.ok) {
        const quoError = await quoResponse.json().catch(() => ({}));
        return json({
          error: quoError?.message || quoError?.error || 'The link was created, but Quo could not send the text.',
          url: paymentLink.url,
          paymentLinkId: paymentLink.id,
          sent: false
        }, 502);
      }
      sent = true;
    }

    return json({ url: paymentLink.url, paymentLinkId: paymentLink.id, sent });
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
