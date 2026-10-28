import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../netlify/functions/invoice-wallet-intent.mts', import.meta.url), 'utf8');
const runnable = source
  .replace(/function json\(body: unknown, status = 200\)/, 'function json(body, status = 200)')
  .replace(/function cleanText\(value: unknown, maximum: number\)/, 'function cleanText(value, maximum)')
  .replace(/function validEmail\(value: string\)/, 'function validEmail(value)')
  .replace(/function validPhone\(value: string\)/, 'function validPhone(value)')
  .replace(/async function stripePost\(path: string, secret: string, body: URLSearchParams, idempotencyKey: string\)/, 'async function stripePost(path, secret, body, idempotencyKey)')
  .replace(/async function stripeGet\(path: string, secret: string\)/, 'async function stripeGet(path, secret)')
  .replace(/export default async \(request: Request\) =>/, 'const handler = async (request) =>')
  .replace(/export const config = [\s\S]*$/, 'export { handler };');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString('base64')}`;
const { handler } = await import(moduleUrl);

function setNetlifyEnv(values = {}) {
  globalThis.Netlify = { env: { get: (key) => values[key] || '' } };
}

test('creates a fixed-price wallet PaymentIntent and optional email receipt', async (t) => {
  setNetlifyEnv({ STRIPE_SECRET_KEY: 'rk_live_example' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let intentBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.stripe.com/v1/payment_intents');
    intentBody = options.body;
    return new Response(JSON.stringify({ id: 'pi_wallet_123', client_secret: 'pi_wallet_123_secret_example' }));
  };

  const response = await handler(new Request('https://mylaunch.dev/api/invoice-wallet-intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'create',
      invoiceId: 'LP-AMG-20261027-01',
      confirmationTokenId: 'ctoken_wallet_123',
      receiptMethod: 'email',
      receiptContact: 'simi@example.com',
      amount: 1,
      requestId: '550e8400-e29b-41d4-a716-446655440010'
    })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    clientSecret: 'pi_wallet_123_secret_example',
    paymentIntentId: 'pi_wallet_123'
  });
  assert.equal(intentBody.get('amount'), '450000');
  assert.equal(intentBody.get('currency'), 'usd');
  assert.equal(intentBody.get('automatic_payment_methods[enabled]'), 'true');
  assert.equal(intentBody.get('receipt_email'), 'simi@example.com');
  assert.equal(intentBody.get('metadata[invoice_id]'), 'LP-AMG-20261027-01');
});

test('sends a phone receipt only after Stripe verifies the completed invoice payment', async (t) => {
  setNetlifyEnv({
    STRIPE_SECRET_KEY: 'rk_live_example',
    QUO_API_KEY: 'quo_example',
    QUO_FROM_NUMBER: '+14436582469'
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let quoPayload;
  globalThis.fetch = async (url, options = {}) => {
    if (url === 'https://api.stripe.com/v1/payment_intents/pi_wallet_456') {
      return new Response(JSON.stringify({
        id: 'pi_wallet_456',
        status: 'succeeded',
        amount_received: 450000,
        currency: 'usd',
        metadata: { invoice_id: 'LP-AMG-20261027-01' }
      }));
    }
    assert.equal(url, 'https://api.quo.com/v1/messages');
    quoPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'message_123' }));
  };

  const response = await handler(new Request('https://mylaunch.dev/api/invoice-wallet-intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'send-phone-receipt',
      invoiceId: 'LP-AMG-20261027-01',
      paymentIntentId: 'pi_wallet_456',
      receiptContact: '+14435550198',
      requestId: '550e8400-e29b-41d4-a716-446655440011'
    })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sent: true });
  assert.deepEqual(quoPayload.to, ['+14435550198']);
  assert.match(quoPayload.content, /\$4,500\.00/);
});

test('does not send a phone receipt for an uncompleted payment', async (t) => {
  setNetlifyEnv({
    STRIPE_SECRET_KEY: 'rk_live_example',
    QUO_API_KEY: 'quo_example',
    QUO_FROM_NUMBER: '+14436582469'
  });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 'pi_wallet_789',
    status: 'requires_payment_method',
    amount_received: 0,
    currency: 'usd',
    metadata: { invoice_id: 'LP-AMG-20261027-01' }
  }));

  const response = await handler(new Request('https://mylaunch.dev/api/invoice-wallet-intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'send-phone-receipt',
      invoiceId: 'LP-AMG-20261027-01',
      paymentIntentId: 'pi_wallet_789',
      receiptContact: '+14435550198'
    })
  }));

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not been completed/i);
});
