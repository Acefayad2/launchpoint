import test from 'node:test';
import assert from 'node:assert/strict';

const values = {
  STRIPE_SECRET_KEY: 'rk_test_example',
  QUO_API_KEY: 'quo_example',
  QUO_FROM_NUMBER: '+14436582469',
  URL: 'https://mylaunch.dev'
};
globalThis.Netlify = { env: { get: (key) => values[key] || '' } };
const { default: createInvoice } = await import('../netlify/functions/payment-links.mts');
const { default: invoiceRequest } = await import('../netlify/functions/invoice-request.mts');

const requestId = '550e8400-e29b-41d4-a716-446655440099';
const intentId = 'pi_testinvoice123456789';
const invoiceUrl = `https://mylaunch.dev/invoice/${intentId}`;
const reference = `LP-${new Date().getUTCFullYear()}-550E8400`;
const stripeInvoice = (overrides = {}) => ({
  id: intentId,
  amount: 125000,
  amount_received: 0,
  currency: 'usd',
  status: 'requires_payment_method',
  created: 1793220000,
  client_secret: `${intentId}_secret_example`,
  metadata: {
    launchpoint_invoice: '1',
    reference,
    company: 'Northline Wellness',
    service_description: 'Website strategy deposit'
  },
  ...overrides
});

function adminFetch(url) {
  if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: 'user_1' }));
  if (url.endsWith('/rest/v1/rpc/current_user_role')) return new Response(JSON.stringify('admin'));
  return null;
}

test('dashboard generates a fixed-price LaunchPoint invoice URL and texts that URL', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let intentBody;
  let textMessage;
  globalThis.fetch = async (url, options = {}) => {
    const admin = adminFetch(url);
    if (admin) return admin;
    if (url === 'https://api.stripe.com/v1/payment_intents') {
      intentBody = options.body;
      return Response.json({ id: intentId });
    }
    if (url === 'https://api.quo.com/v1/messages') {
      textMessage = JSON.parse(options.body);
      return Response.json({ id: 'message_1' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const response = await createInvoice(new Request('https://mylaunch.dev/api/payment-links', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'Northline Wellness', description: 'Website strategy deposit', amount: 1250, phone: '+14435550198', action: 'send', requestId })
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: invoiceUrl, paymentIntentId: intentId, reference, sent: true });
  assert.equal(intentBody.get('amount'), '125000');
  assert.equal(intentBody.get('currency'), 'usd');
  assert.equal(intentBody.get('metadata[company]'), 'Northline Wellness');
  assert.equal(intentBody.get('metadata[service_description]'), 'Website strategy deposit');
  assert.equal(intentBody.get('automatic_payment_methods[enabled]'), 'true');
  assert.match(textMessage.content, /mylaunch\.dev\/invoice\/pi_testinvoice123456789/);
  assert.deepEqual(textMessage.to, ['+14435550198']);
});

test('client invoice loads only a server-created Stripe PaymentIntent', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json(stripeInvoice());
  const response = await invoiceRequest(new Request(`https://mylaunch.dev/api/invoice-request?id=${intentId}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: intentId, reference, company: 'Northline Wellness',
    description: 'Website strategy deposit', amount: 125000, currency: 'usd',
    status: 'requires_payment_method', created: 1793220000,
    clientSecret: `${intentId}_secret_example`, card: null
  });
  globalThis.fetch = async () => Response.json(stripeInvoice({ metadata: { company: 'Unrelated' } }));
  const unrelated = await invoiceRequest(new Request(`https://mylaunch.dev/api/invoice-request?id=${intentId}`));
  assert.equal(unrelated.status, 404);
});

test('paid invoices reveal verified card summary but no client secret, and cannot be paid again', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => Response.json(stripeInvoice({
    status: 'succeeded', amount_received: 125000,
    ...(url.includes('expand%5B%5D=latest_charge') ? { latest_charge: { payment_method_details: { card: { brand: 'visa', last4: '4242' } } } } : {})
  }));
  const response = await invoiceRequest(new Request(`https://mylaunch.dev/api/invoice-request?id=${intentId}`));
  const paid = await response.json();
  assert.equal(paid.clientSecret, null);
  assert.deepEqual(paid.card, { brand: 'visa', last4: '4242' });
  const email = await invoiceRequest(new Request('https://mylaunch.dev/api/invoice-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: intentId, action: 'set-email', email: 'receipt@example.com' })
  }));
  assert.equal(email.status, 409);
});

test('wallet token last four is not presented as the underlying card number', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json(stripeInvoice({
    status: 'succeeded', amount_received: 125000,
    latest_charge: { payment_method_details: { card: { brand: 'visa', last4: '1234', wallet: { type: 'apple_pay' } } } }
  }));
  const response = await invoiceRequest(new Request(`https://mylaunch.dev/api/invoice-request?id=${intentId}`));
  assert.equal((await response.json()).card, null);
});

test('optional email receipt is set before payment; phone receipt requires verified success', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let completed = false;
  let emailBody;
  let textMessage;
  globalThis.fetch = async (url, options = {}) => {
    if (url === `https://api.stripe.com/v1/payment_intents/${intentId}` && !options.body) {
      return Response.json(stripeInvoice(completed ? { status: 'succeeded', amount_received: 125000 } : {}));
    }
    if (url === `https://api.stripe.com/v1/payment_intents/${intentId}`) {
      if (options.body.has('receipt_email')) emailBody = options.body;
      return Response.json(stripeInvoice());
    }
    if (url === 'https://api.quo.com/v1/messages') {
      textMessage = JSON.parse(options.body);
      return Response.json({ id: 'message_2' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const email = await invoiceRequest(new Request('https://mylaunch.dev/api/invoice-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: intentId, action: 'set-email', email: 'Receipt@Example.com' })
  }));
  assert.equal(email.status, 200);
  assert.equal(emailBody.get('receipt_email'), 'receipt@example.com');
  const pendingText = await invoiceRequest(new Request('https://mylaunch.dev/api/invoice-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: intentId, action: 'send-phone-receipt', phone: '+14435550198' })
  }));
  assert.equal(pendingText.status, 409);
  assert.equal(textMessage, undefined);
  completed = true;
  const paidText = await invoiceRequest(new Request('https://mylaunch.dev/api/invoice-request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: intentId, action: 'send-phone-receipt', phone: '+14435550198' })
  }));
  assert.equal(paidText.status, 200);
  assert.match(textMessage.content, /\$1,250\.00 paid/);
});
