const STRIPE_API = 'https://api.stripe.com/v1';

const INVOICES = new Map([
  ['LP-AMG-20261027-01', {
    amountInCents: 450_000,
    customer: 'Anointed Money Group (AMG)',
    description: 'Website, domain, SMS administration and Supabase setup',
    label: 'LaunchPoint Website and CRM Invoice'
  }]
]);

const responseHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maximum) : '';
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe could not start checkout.');
  return data;
}

export default async (request: Request) => {
  try {
    const stripeSecret = Netlify.env.get('STRIPE_SECRET_KEY') || '';

    if (request.method === 'GET') return json({ stripeConnected: Boolean(stripeSecret) });
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!stripeSecret) return json({ error: 'LaunchPoint secure checkout is being connected. Please try again shortly.' }, 503);

    const payload = await request.json().catch(() => ({}));
    const name = cleanText(payload.name, 100);
    const email = cleanText(payload.email, 160).toLowerCase();
    const invoiceId = cleanText(payload.invoiceId, 80);
    const preferredMethod = payload.preferredMethod === 'apple_pay' ? 'apple_pay' : 'card';
    const invoice = INVOICES.get(invoiceId);
    const requestId = /^[a-f0-9-]{36}$/i.test(payload.requestId || '') ? payload.requestId : crypto.randomUUID();

    if (!invoice) return json({ error: 'This invoice could not be found.' }, 404);
    if (!name) return json({ error: 'Enter your full name.' }, 400);
    if (!validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);

    const origin = new URL(request.url).origin;
    const siteUrl = (Netlify.env.get('URL') || origin || 'https://mylaunch.dev').replace(/\/$/, '');
    const metadata = {
      invoice_id: invoiceId,
      payer_name: name,
      preferred_method: preferredMethod,
      request_id: requestId
    };

    const productBody = new URLSearchParams({
      name: invoice.label,
      description: `${invoice.customer} - ${invoiceId} - ${invoice.description}`.slice(0, 500),
      'metadata[invoice_id]': metadata.invoice_id,
      'metadata[payer_name]': metadata.payer_name,
      'metadata[preferred_method]': metadata.preferred_method,
      'metadata[receipt_email]': email,
      'metadata[request_id]': metadata.request_id
    });
    const product = await stripeRequest('/products', stripeSecret, productBody, `${requestId}-${invoiceId}-product`);

    const priceBody = new URLSearchParams({
      currency: 'usd',
      unit_amount: String(invoice.amountInCents),
      product: product.id,
      'metadata[invoice_id]': metadata.invoice_id,
      'metadata[request_id]': metadata.request_id
    });
    const price = await stripeRequest('/prices', stripeSecret, priceBody, `${requestId}-${invoiceId}-price`);

    const linkBody = new URLSearchParams({
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': '1',
      'restrictions[completed_sessions][limit]': '1',
      'after_completion[type]': 'redirect',
      'after_completion[redirect][url]': `${siteUrl}/payment-success.html`,
      'payment_intent_data[description]': `${invoiceId}: ${invoice.label}`.slice(0, 500),
      'payment_intent_data[metadata][invoice_id]': metadata.invoice_id,
      'payment_intent_data[metadata][payer_name]': metadata.payer_name,
      'payment_intent_data[metadata][preferred_method]': metadata.preferred_method,
      'payment_intent_data[metadata][receipt_email]': email,
      'payment_intent_data[metadata][request_id]': metadata.request_id,
      'metadata[invoice_id]': metadata.invoice_id,
      'metadata[payer_name]': metadata.payer_name,
      'metadata[preferred_method]': metadata.preferred_method,
      'metadata[receipt_email]': email,
      'metadata[request_id]': metadata.request_id,
      'custom_text[submit][message]': `Payment for LaunchPoint invoice ${invoiceId}. Processed securely by Stripe.`
    });

    const paymentLink = await stripeRequest('/payment_links', stripeSecret, linkBody, `${requestId}-${invoiceId}-link`);
    return json({ url: paymentLink.url, paymentLinkId: paymentLink.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Checkout could not be started.' }, 500);
  }
};

export const config = {
  path: '/api/invoice-checkout',
  method: ['GET', 'POST'],
  rateLimit: { action: 'rate_limit', windowLimit: 20, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
