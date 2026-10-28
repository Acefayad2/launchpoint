const INVOICE_ID = 'LP-AMG-20261027-01';
const form = document.querySelector('#payment-form');
const button = document.querySelector('#checkout-button');
const status = document.querySelector('#form-status');
const canceledNotice = document.querySelector('#canceled-notice');
const fields = {
  name: document.querySelector('#name'),
  email: document.querySelector('#email')
};

const params = new URLSearchParams(window.location.search);
if (params.get('name')) fields.name.value = params.get('name').slice(0, 100);
if (params.get('email')) fields.email.value = params.get('email').slice(0, 160);
if (params.get('canceled') === '1') canceledNotice.hidden = false;

function setError(name, message) {
  const field = fields[name];
  const error = document.querySelector(`#${name}-error`);
  field.setAttribute('aria-invalid', message ? 'true' : 'false');
  error.textContent = message;
}

function validate() {
  const values = {
    name: fields.name.value.trim(),
    email: fields.email.value.trim()
  };
  const errors = {
    name: values.name ? '' : 'Enter the payer name.',
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email) ? '' : 'Enter a valid receipt email.'
  };

  Object.entries(errors).forEach(([name, message]) => setError(name, message));
  const firstError = Object.entries(errors).find(([, message]) => message);
  if (firstError) {
    fields[firstError[0]].focus();
    return null;
  }
  return values;
}

Object.entries(fields).forEach(([name, field]) => {
  field.addEventListener('input', () => {
    setError(name, '');
    status.textContent = '';
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = validate();
  if (!values) return;

  const label = button.querySelector('span');
  const originalLabel = label.textContent;
  button.disabled = true;
  label.textContent = 'Preparing secure checkout';
  status.textContent = '';

  try {
    const response = await fetch('/api/invoice-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: INVOICE_ID,
        ...values,
        requestId: crypto.randomUUID()
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new Error(result.error || 'Checkout could not be started. Please try again.');
    window.location.assign(result.url);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Checkout could not be started. Please try again.';
    button.disabled = false;
    label.textContent = originalLabel;
  }
});
