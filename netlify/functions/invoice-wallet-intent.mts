const STRIPE_API = 'https://api.stripe.com/v1';
const QUO_MESSAGES_API = 'https://api.quo.com/v1/messages';

const INVOICES = new Map([
  ['LP-AMG-20261027-01', {
    amountInCents: 450_000,
    currency: 'usd',
    customer: 'Anointed Money Group (AMG)',
    recipient: 'Simisola Ajimatanrareje',
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

function validPhone(value: string) {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

async function stripePost(path: string, secret: string, body: URLSearchParams, idempotencyKey: string) {
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
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe could not start the wallet payment.');
  return data;
}

async function stripeGet(path: string, secret: string) {
  const response = await fetch(`${STRIPE_API}${path}`, {
    headers: { authorization: `Bearer ${secret}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Stripe could not verify the payment.');
  return data;
}

export default async (request: Request) => {
  try {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);

    const stripeSecret = Netlify.env.get('STRIPE_SECRET_KEY') || '';
    const quoApiKey = Netlify.env.get('QUO_API_KEY') || '';
    const quoFromNumber = (Netlify.env.get('QUO_FROM_NUMBER') || '').replace(/[^+\d]/g, '');
    if (!stripeSecret) return json({ error: 'LaunchPoint secure checkout is being connected. Please try again shortly.' }, 503);

    const payload = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const invoiceId = request.method === 'GET' ? new URL(request.url).searchParams.get('invoiceId') || '' : cleanText(payload.invoiceId, 80);
    const invoice = INVOICES.get(invoiceId);
    const action = payload.action === 'send-phone-receipt' ? 'send-phone-receipt' : 'create';
    const requestId = /^[a-f0-9-]{36}$/i.test(payload.requestId || '') ? payload.requestId : crypto.randomUUID();
    if (!invoice) return json({ error: 'This invoice could not be found.' }, 404);

    if (request.method === 'GET') {
      const paymentIntentId = new URL(request.url).searchParams.get('paymentIntentId') || '';
      if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) return json({ error: 'The payment could not be verified.' }, 400);
      const paymentIntent = await stripeGet(`/payment_intents/${encodeURIComponent(paymentIntentId)}?expand%5B%5D=latest_charge`, stripeSecret);
      if (paymentIntent.status !== 'succeeded' || paymentIntent.amount_received !== invoice.amountInCents
        || paymentIntent.currency !== invoice.currency || paymentIntent.metadata?.invoice_id !== invoiceId) {
        return json({ error: 'The payment has not been completed.' }, 409);
      }
      const details = paymentIntent.latest_charge?.payment_method_details?.card;
      const card = !details?.wallet && /^[0-9]{4}$/.test(details?.last4 || '') && /^[a-z_]+$/.test(details?.brand || '')
        ? { brand: details.brand, last4: details.last4 } : null;
      return json({ card });
    }

    if (action === 'send-phone-receipt') {
      const phone = cleanText(payload.receiptContact, 24).replace(/[^+\d]/g, '');
      const paymentIntentId = cleanText(payload.paymentIntentId, 80);
      if (!validPhone(phone)) return json({ error: 'Enter a valid mobile number.' }, 400);
      if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) return json({ error: 'The payment could not be verified.' }, 400);
      if (!quoApiKey || !validPhone(quoFromNumber)) return json({ error: 'Text receipt delivery is temporarily unavailable.' }, 503);

      const paymentIntent = await stripeGet(`/payment_intents/${encodeURIComponent(paymentIntentId)}`, stripeSecret);
      const validPayment = paymentIntent.status === 'succeeded'
        && paymentIntent.amount_received === invoice.amountInCents
        && paymentIntent.currency === invoice.currency
        && paymentIntent.metadata?.invoice_id === invoiceId;
      if (!validPayment) return json({ error: 'The payment has not been completed, so a receipt was not sent.' }, 409);

      const quoResponse = await fetch(QUO_MESSAGES_API, {
        method: 'POST',
        headers: { authorization: quoApiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `LaunchPoint receipt: $4,500.00 payment received for invoice ${invoiceId}. Thank you, ${invoice.recipient}.`,
          from: quoFromNumber,
          to: [phone]
        })
      });
      if (!quoResponse.ok) return json({ error: 'The payment succeeded, but the text receipt could not be sent.' }, 502);
      return json({ sent: true });
    }

    const receiptMethod = ['email', 'phone'].includes(payload.receiptMethod) ? payload.receiptMethod : 'none';
    const receiptContact = cleanText(payload.receiptContact, 160).toLowerCase();
    const email = receiptMethod === 'email' ? receiptContact : '';
    const phone = receiptMethod === 'phone' ? receiptContact.replace(/[^+\d]/g, '') : '';
    const confirmationTokenId = cleanText(payload.confirmationTokenId, 100);
    if (!/^ctoken_[A-Za-z0-9_]+$/.test(confirmationTokenId)) return json({ error: 'The wallet authorization could not be verified.' }, 400);
    if (receiptMethod === 'email' && !validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (receiptMethod === 'phone' && !validPhone(phone)) return json({ error: 'Enter a valid mobile number.' }, 400);
    if (receiptMethod === 'phone' && (!quoApiKey || !validPhone(quoFromNumber))) {
      return json({ error: 'Text receipt delivery is temporarily unavailable. Choose email or continue without a receipt.' }, 503);
    }

    const intentBody = new URLSearchParams({
      amount: String(invoice.amountInCents),
      currency: invoice.currency,
      description: `${invoiceId}: ${invoice.label}`,
      'automatic_payment_methods[enabled]': 'true',
      'metadata[invoice_id]': invoiceId,
      'metadata[recipient_name]': invoice.recipient,
      'metadata[receipt_method]': receiptMethod,
      'metadata[request_id]': requestId,
      'metadata[confirmation_token_id]': confirmationTokenId
    });
    if (email) intentBody.set('receipt_email', email);

    const paymentIntent = await stripePost('/payment_intents', stripeSecret, intentBody, `${requestId}-${invoiceId}-wallet-intent`);
    return json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Wallet payment could not be started.' }, 500);
  }
};

export const config = {
  path: '/api/invoice-wallet-intent',
  method: ['GET', 'POST'],
  rateLimit: { action: 'rate_limit', windowLimit: 20, windowSize: 60, aggregateBy: ['domain', 'ip'] }
};
