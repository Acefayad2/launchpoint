const STRIPE_API = 'https://api.stripe.com/v1';
const QUO_MESSAGES_API = 'https://api.quo.com/v1/messages';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

function validId(value: unknown) {
  return typeof value === 'string' && /^pi_[A-Za-z0-9_]{10,80}$/.test(value);
}

function validEmail(value: unknown) {
  return typeof value === 'string' && value.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPhone(value: unknown) {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value);
}

async function stripeRequest(path: string, secret: string, body?: URLSearchParams, idempotencyKey?: string) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    },
    ...(body ? { body } : {})
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Stripe invoice request failed.');
  return response.json();
}

export default async (request: Request) => {
  try {
    const secret = Netlify.env.get('STRIPE_SECRET_KEY') || '';
    if (!secret) return json({ error: 'Secure checkout is temporarily unavailable.' }, 503);

    const payload = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const id = request.method === 'GET' ? new URL(request.url).searchParams.get('id') : payload.id;
    if (!validId(id)) return json({ error: 'Invoice not found.' }, 404);

    const intent = await stripeRequest(`/payment_intents/${encodeURIComponent(id)}`, secret);
    if (!intent || intent.metadata?.launchpoint_invoice !== '1'
      || !intent.metadata?.company || !intent.metadata?.service_description
      || intent.currency !== 'usd' || !Number.isSafeInteger(intent.amount)
      || intent.amount < 100 || intent.amount > 5_000_000) {
      return json({ error: 'Invoice not found.' }, 404);
    }

    if (request.method === 'GET') {
      let card = null;
      if (intent.status === 'succeeded' && intent.amount_received === intent.amount) {
        try {
          const paidIntent = await stripeRequest(`/payment_intents/${encodeURIComponent(id)}?expand%5B%5D=latest_charge`, secret);
          const details = paidIntent?.latest_charge?.payment_method_details?.card;
          if (!details?.wallet && /^[0-9]{4}$/.test(details?.last4 || '') && /^[a-z_]+$/.test(details?.brand || '')) {
            card = { brand: details.brand, last4: details.last4 };
          }
        } catch { /* Card display is optional; never block a paid invoice. */ }
      }
      return json({
        id: intent.id,
        reference: intent.metadata.reference,
        company: intent.metadata.company,
        description: intent.metadata.service_description,
        amount: intent.amount,
        currency: intent.currency,
        status: intent.status,
        created: intent.created,
        clientSecret: intent.status === 'requires_payment_method' ? intent.client_secret : null,
        card
      });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

    if (payload.action === 'set-email') {
      const email = String(payload.email || '').trim().toLowerCase();
      if (!validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
      if (intent.status !== 'requires_payment_method') return json({ error: 'This invoice is no longer awaiting payment.' }, 409);
      await stripeRequest(`/payment_intents/${encodeURIComponent(id)}`, secret, new URLSearchParams({ receipt_email: email }));
      return json({ saved: true });
    }

    if (payload.action === 'set-phone') {
      const phone = String(payload.phone || '').trim();
      if (!validPhone(phone)) return json({ error: 'Enter a valid mobile number.' }, 400);
      if (intent.status !== 'requires_payment_method') return json({ error: 'This invoice is no longer awaiting payment.' }, 409);
      await stripeRequest(`/payment_intents/${encodeURIComponent(id)}`, secret,
        new URLSearchParams({ 'metadata[receipt_phone]': phone }));
      return json({ saved: true });
    }

    if (payload.action === 'send-phone-receipt') {
      const phone = String(payload.phone || '').trim();
      if (!validPhone(phone)) return json({ error: 'Enter a valid mobile number.' }, 400);
      if (intent.status !== 'succeeded' || intent.amount_received !== intent.amount) {
        return json({ error: 'The payment has not completed, so a receipt was not sent.' }, 409);
      }
      if (intent.metadata.receipt_phone !== phone) return json({ error: 'The receipt number was not chosen before payment.' }, 403);
      if (intent.metadata.receipt_sent === '1') return json({ sent: true });
      const quoApiKey = Netlify.env.get('QUO_API_KEY') || '';
      const from = (Netlify.env.get('QUO_FROM_NUMBER') || '').replace(/[^+\d]/g, '');
      if (!quoApiKey || !validPhone(from)) return json({ error: 'Text receipts are temporarily unavailable.' }, 503);
      const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(intent.amount / 100);
      const receiptUrl = new URL(`/api/paid-receipt?id=${encodeURIComponent(id)}`, request.url).href;
      const quoResponse = await fetch(QUO_MESSAGES_API, {
        method: 'POST',
        headers: { authorization: quoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `LaunchPoint receipt: ${dollars} paid for invoice ${intent.metadata.reference}. Download your paid invoice PDF: ${receiptUrl}`,
          from,
          to: [phone]
        })
      });
      if (!quoResponse.ok) return json({ error: 'Payment succeeded, but the text receipt could not be sent.' }, 502);
      await stripeRequest(`/payment_intents/${encodeURIComponent(id)}`, secret, new URLSearchParams({
        'metadata[receipt_phone]': phone,
        'metadata[receipt_sent]': '1'
      }), `invoice-${id}-phone-receipt`);
      return json({ sent: true });
    }

    return json({ error: 'Invalid invoice action.' }, 400);
  } catch {
    return json({ error: 'The invoice could not be loaded. Please try again.' }, 503);
  }
};

export const config = {
  path: '/api/invoice-request',
  method: ['GET', 'POST'],
  rateLimit: { action: 'rate_limit', windowLimit: 30, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
