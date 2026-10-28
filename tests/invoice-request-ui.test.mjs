import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/invoice-request.js', import.meta.url), 'utf8');

test('dashboard invoice shows a paid card summary only after a successful payment', async () => {
  const nodes = new Map();
  const element = () => {
    const classes = new Set(['step-current']);
    return {
      hidden: false, checked: false, value: '', textContent: '', children: [],
      classList: { add: (...values) => values.forEach((value) => classes.add(value)), remove: (...values) => values.forEach((value) => classes.delete(value)), contains: (value) => classes.has(value) },
      setAttribute() {}, removeAttribute() {}, addEventListener() {}, append(child) { this.children.push(child); }, replaceWith(next) { this.replacement = next; }
    };
  };
  const get = (selector) => { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); };
  const sandbox = {
    document: { querySelector: get, querySelectorAll: () => [{ ...element(), checked: true, value: 'email' }], createElement: element, title: '' },
    location: { pathname: '/invoice/pi_testinvoice123456789' },
    sessionStorage: { getItem: () => null },
    fetch: async () => Response.json({
      id: 'pi_testinvoice123456789', reference: 'LP-2026-TEST', company: 'Northline Wellness',
      description: 'Website strategy deposit', amount: 125000, status: 'succeeded', created: 1793220000,
      card: { brand: 'mastercard', last4: '4444' }
    }),
    Intl, Date, URLSearchParams
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  await new Promise(setImmediate);
  assert.equal(get('#card-entry-label').textContent, '•••• 4444');
  assert.equal(get('#card-method').textContent, 'Mastercard');
  assert.equal(get('#card-stage').classList.contains('is-paid'), true);
  assert.equal(get('#invoice-status').textContent, 'Paid');
});
