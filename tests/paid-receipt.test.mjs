import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import receipt from '../netlify/functions/paid-receipt.mts';

const id = 'pi_testreceipt1234567890';
const paid = {
  id, amount: 100, amount_received: 100, currency: 'usd', status: 'succeeded', livemode: true,
  created: 1793290000,
  metadata: {
    launchpoint_invoice: '1', reference: 'LP-2026-TEST', company: 'LaunchPoint checkout test',
    service_description: 'Live Apple Pay verification'
  },
  latest_charge: { created: 1793290100, payment_method_details: { type: 'card', card: { wallet: { type: 'apple_pay' } } } }
};

async function withStripe(intent, run) {
  const originalFetch = globalThis.fetch;
  const originalNetlify = globalThis.Netlify;
  globalThis.Netlify = { env: { get: (key) => key === 'STRIPE_SECRET_KEY' ? 'sk_test_fixture' : '' } };
  globalThis.fetch = async () => Response.json(intent);
  try { return await run(); }
  finally { globalThis.fetch = originalFetch; globalThis.Netlify = originalNetlify; }
}

test('paid live invoice returns a valid downloadable PDF', async () => {
  await withStripe(paid, async () => {
    const response = await receipt(new Request(`https://mylaunch.dev/api/paid-receipt?id=${id}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('content-disposition'), /LP-2026-TEST-paid\.pdf/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  });
});

test('unpaid invoice cannot return a paid document', async () => {
  await withStripe({ ...paid, status: 'requires_payment_method', amount_received: 0 }, async () => {
    const response = await receipt(new Request(`https://mylaunch.dev/api/paid-receipt?id=${id}`));
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  });
});

test('unrelated Stripe payment cannot return a LaunchPoint receipt', async () => {
  await withStripe({ ...paid, metadata: {} }, async () => {
    const response = await receipt(new Request(`https://mylaunch.dev/api/paid-receipt?id=${id}`));
    assert.equal(response.status, 409);
  });
});

test('AMG receipt is available only after its exact invoice amount succeeds', async () => {
  await withStripe({
    ...paid, amount: 450_000, amount_received: 450_000,
    metadata: { invoice_id: 'LP-AMG-20261027-01' }
  }, async () => {
    const response = await receipt(new Request(`https://mylaunch.dev/api/paid-receipt?id=${id}`));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /LP-AMG-20261027-01-paid\.pdf/);
  });
});
