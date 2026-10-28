import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../netlify/functions/invoice-checkout.mts', import.meta.url), 'utf8');
const runnable = source
  .replace(/function json\(body: unknown, status = 200\)/, 'function json(body, status = 200)')
  .replace(/function cleanText\(value: unknown, maximum: number\)/, 'function cleanText(value, maximum)')
  .replace(/function validEmail\(value: string\)/, 'function validEmail(value)')
  .replace(/async function stripeRequest\(path: string, secret: string, body: URLSearchParams, idempotencyKey: string\)/, 'async function stripeRequest(path, secret, body, idempotencyKey)')
  .replace(/export default async \(request: Request\) =>/, 'const handler = async (request) =>')
  .replace(/export const config = [\s\S]*$/, 'export { handler };');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(runnable).toString('base64')}`;
const { handler } = await import(moduleUrl);

function setNetlifyEnv(values = {}) {
  globalThis.Netlify = { env: { get: (key) => values[key] || '' } };
}

test('reports whether Stripe is connected without exposing a key', async () => {
  setNetlifyEnv({ STRIPE_SECRET_KEY: 'rk_live_example' });
  const response = await handler(new Request('https://example.com/api/invoice-checkout'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stripeConnected: true });
});

test('rejects an invoice that is not in the server-side catalog', async () => {
  setNetlifyEnv({ STRIPE_SECRET_KEY: 'rk_live_example' });
  const response = await handler(new Request('https://example.com/api/invoice-checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Amina Cole', email: 'amina@example.com', invoiceId: 'not-a-real-invoice' })
  }));
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /invoice/i);
});

test('creates a fixed-price single-use Stripe Payment Link for the AMG invoice', async (t) => {
  setNetlifyEnv({ STRIPE_SECRET_KEY: 'rk_live_example', URL: 'https://mylaunch.dev' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const stripeBodies = new Map();
  globalThis.fetch = async (url, options) => {
    assert.equal(options.method, 'POST');
    stripeBodies.set(url, options.body);
    const responseByUrl = {
      'https://api.stripe.com/v1/products': { id: 'prod_test_123' },
      'https://api.stripe.com/v1/prices': { id: 'price_test_123' },
      'https://api.stripe.com/v1/payment_links': { id: 'plink_test_123', url: 'https://buy.stripe.com/example' }
    };
    assert.ok(responseByUrl[url], `Unexpected Stripe endpoint: ${url}`);
    return new Response(JSON.stringify(responseByUrl[url]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const response = await handler(new Request('https://mylaunch.dev/api/invoice-checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Amina Cole',
      email: 'amina@example.com',
      invoiceId: 'LP-AMG-20261027-01',
      preferredMethod: 'apple_pay',
      amount: 1,
      requestId: '550e8400-e29b-41d4-a716-446655440000'
    })
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: 'https://buy.stripe.com/example', paymentLinkId: 'plink_test_123' });

  const productBody = stripeBodies.get('https://api.stripe.com/v1/products');
  const priceBody = stripeBodies.get('https://api.stripe.com/v1/prices');
  const linkBody = stripeBodies.get('https://api.stripe.com/v1/payment_links');
  assert.equal(productBody.get('metadata[receipt_email]'), 'amina@example.com');
  assert.equal(priceBody.get('unit_amount'), '450000');
  assert.equal(linkBody.get('line_items[0][price]'), 'price_test_123');
  assert.equal(linkBody.get('restrictions[completed_sessions][limit]'), '1');
  assert.equal(linkBody.get('metadata[invoice_id]'), 'LP-AMG-20261027-01');
  assert.equal(linkBody.get('metadata[preferred_method]'), 'apple_pay');
  assert.equal(linkBody.get('payment_intent_data[metadata][preferred_method]'), 'apple_pay');
  assert.equal(linkBody.get('after_completion[redirect][url]'), 'https://mylaunch.dev/payment-success.html');
});
