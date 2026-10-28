import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/invoice.js', import.meta.url), 'utf8');

function element() {
  const classes = new Set();
  return {
    hidden: false, checked: false, value: '', textContent: '', events: {}, children: [],
    classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v), contains: (v) => classes.has(v), toggle(v, force) { const add = force ?? !classes.has(v); if (add) classes.add(v); else classes.delete(v); return add; } },
    setAttribute() {}, removeAttribute() {}, focus() {}, append(child) { this.children.push(child); },
    addEventListener(name, callback) { this.events[name] = callback; },
    replaceWith(next) { this.replacement = next; }
  };
}

async function setup({ confirmation, submitError, phoneReceipt = false, receiptFailure = false, redirectResult } = {}) {
  const nodes = new Map();
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const radio = { ...element(), checked: true, value: phoneReceipt ? 'phone' : 'email' };
  const stripeElements = new Map();
  let intentRequests = 0;
  let confirms = 0;
  let receiptRequests = 0;
  const storage = new Map();
  if (redirectResult && phoneReceipt) storage.set('receipt:pi_example', JSON.stringify({ receiptMethod: 'phone', receiptContact: '+14435550198', requestId: 'example' }));
  const stripe = {
    elements: () => ({
      create(type) { const widget = { events: {}, on(name, callback) { this.events[name] = callback; }, mount() { this.events.ready?.({ availablePaymentMethods: { applePay: true } }); } }; stripeElements.set(type, widget); return widget; },
      submit: async () => ({ error: submitError })
    }),
    createConfirmationToken: async () => ({ confirmationToken: { id: 'ctoken_example' } }),
    confirmPayment: async () => { confirms++; return confirmation || { paymentIntent: { id: 'pi_example', status: 'succeeded' } }; },
    retrievePaymentIntent: async () => redirectResult
  };
  const sandbox = {
    document: { querySelector: get, querySelectorAll: () => [radio], createElement: element },
    window: { Stripe: () => stripe, location: { search: redirectResult ? '?payment_intent_client_secret=example' : '', origin: 'https://mylaunch.dev', pathname: '/invoice/amg', assign() {} } },
    history: { replaceState() {} },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    URLSearchParams, crypto: { randomUUID: () => '550e8400-e29b-41d4-a716-446655440010' },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.action === 'send-phone-receipt') { receiptRequests++; return { ok: !receiptFailure, json: async () => ({ error: 'Receipt delivery failed.' }) }; }
      intentRequests++;
      return { ok: true, json: async () => ({ clientSecret: 'pi_secret_example', paymentIntentId: 'pi_example' }) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await new Promise(setImmediate);
  if (phoneReceipt) { get('#send-receipt').checked = true; get('#receipt-contact').value = '4435550198'; }
  return { nodes, get, paymentElement: stripeElements.get('payment'), submit: () => stripeElements.get('expressCheckout').events.confirm(), intentRequests: () => intentRequests, confirms: () => confirms, receiptRequests: () => receiptRequests };
}

test('decorative masked number responds only to incomplete card entry', async () => {
  const ui = await setup();
  const stage = ui.get('#card-stage');
  ui.paymentElement.events.change({ value: { type: 'card' }, empty: false, complete: false });
  assert.equal(stage.classList.contains('is-card-entry'), true);
  ui.paymentElement.events.change({ value: { type: 'card' }, empty: false, complete: true });
  assert.equal(stage.classList.contains('is-card-entry'), false);
  assert.equal(stage.classList.contains('is-complete'), true);
  ui.paymentElement.events.change({ value: { type: 'klarna' }, empty: false, complete: false });
  assert.equal(stage.classList.contains('is-card-entry'), false);
});

test('invalid Stripe fields do not create a payment or show success', async () => {
  const ui = await setup({ submitError: { message: 'Enter your card number.' } });
  await ui.submit();
  assert.equal(ui.intentRequests(), 0);
  assert.equal(ui.confirms(), 0);
  assert.equal(ui.get('#form-status').textContent, 'Enter your card number.');
  assert.equal(ui.get('#payment-form').replacement, undefined);
  assert.equal(ui.get('#pay-button').disabled, false);
});

test('declines remain retryable and reuse the existing PaymentIntent', async () => {
  const ui = await setup({ confirmation: { error: { message: 'Your card was declined.' } } });
  await ui.submit();
  await ui.submit();
  assert.equal(ui.intentRequests(), 1);
  assert.equal(ui.confirms(), 2);
  assert.equal(ui.get('#payment-form').replacement, undefined);
  assert.equal(ui.get('#form-status').textContent, 'Your card was declined.');
  assert.equal(ui.get('#send-receipt').disabled, true);
});

test('unverified redirected payments block another charge', async () => {
  const ui = await setup({ redirectResult: { error: { message: 'Network unavailable' } } });
  assert.equal(ui.get('#pay-button').disabled, true);
  assert.match(ui.get('#form-status').textContent, /Do not pay again/);
  assert.equal(ui.intentRequests(), 0);
});

test('successful provider redirects deliver the saved optional text receipt', async () => {
  const ui = await setup({ phoneReceipt: true, redirectResult: { paymentIntent: { id: 'pi_example', status: 'succeeded', amount: 450000, currency: 'usd' } } });
  assert.equal(ui.get('.invoice-status').textContent, 'Paid');
  assert.equal(ui.receiptRequests(), 1);
  assert.equal(ui.intentRequests(), 0);
});

test('pending bank payments display processing instead of paid', async () => {
  const ui = await setup({ confirmation: { paymentIntent: { id: 'pi_example', status: 'processing' } } });
  await ui.submit();
  assert.equal(ui.get('.invoice-status').textContent, 'Processing');
  assert.match(ui.get('#payment-form').replacement.innerHTML, /Payment processing/);
  assert.doesNotMatch(ui.get('#payment-form').replacement.innerHTML, /Payment received/);
});

test('receipt delivery failure does not turn a successful payment into a retry', async () => {
  const ui = await setup({ phoneReceipt: true, receiptFailure: true });
  await ui.submit();
  assert.equal(ui.get('.invoice-status').textContent, 'Paid');
  assert.match(ui.get('#payment-form').replacement.innerHTML, /Payment received/);
  assert.match(ui.get('#payment-form').replacement.children[0].textContent, /payment succeeded/);
  await ui.submit();
  assert.equal(ui.confirms(), 1);
});
