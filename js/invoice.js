const INVOICE_ID = 'LP-AMG-20261027-01';
const form = document.querySelector('#payment-form');
const paymentButtons = [...document.querySelectorAll('[data-payment-method]')];
const status = document.querySelector('#form-status');
const canceledNotice = document.querySelector('#canceled-notice');
const sendReceipt = document.querySelector('#send-receipt');
const receiptOptions = document.querySelector('#receipt-options');
const receiptContact = document.querySelector('#receipt-contact');
const receiptContactLabel = document.querySelector('#receipt-contact-label');
const receiptMethodInputs = [...document.querySelectorAll('input[name="receiptMethod"]')];

const params = new URLSearchParams(window.location.search);
if (params.get('canceled') === '1') canceledNotice.hidden = false;

function currentReceiptMethod() {
  return receiptMethodInputs.find((input) => input.checked)?.value || 'email';
}

function setReceiptError(message) {
  receiptContact.setAttribute('aria-invalid', message ? 'true' : 'false');
  document.querySelector('#receipt-contact-error').textContent = message;
}

function updateReceiptField() {
  const enabled = sendReceipt.checked;
  const method = currentReceiptMethod();
  receiptOptions.hidden = !enabled;
  receiptContact.disabled = !enabled;
  receiptContact.type = method === 'email' ? 'email' : 'tel';
  receiptContact.inputMode = method === 'email' ? 'email' : 'tel';
  receiptContact.autocomplete = method === 'email' ? 'email' : 'tel';
  receiptContact.maxLength = method === 'email' ? 160 : 24;
  receiptContactLabel.textContent = method === 'email' ? 'Email address' : 'Mobile number';
  receiptContact.placeholder = method === 'email' ? 'name@company.com' : '(443) 555-0198';
  receiptContact.value = '';
  setReceiptError('');
  status.textContent = '';
}

function normalizePhone(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

function validate() {
  if (!sendReceipt.checked) return { receiptMethod: 'none', receiptContact: '' };

  const method = currentReceiptMethod();
  const value = receiptContact.value.trim();
  const normalizedValue = method === 'phone' ? normalizePhone(value) : value.toLowerCase();
  const valid = method === 'email'
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedValue)
    : Boolean(normalizedValue);

  if (!valid) {
    setReceiptError(method === 'email' ? 'Enter a valid email address.' : 'Enter a valid mobile number.');
    receiptContact.focus();
    return null;
  }

  setReceiptError('');
  return { receiptMethod: method, receiptContact: normalizedValue };
}

sendReceipt.addEventListener('change', updateReceiptField);
receiptMethodInputs.forEach((input) => input.addEventListener('change', updateReceiptField));
receiptContact.addEventListener('input', () => {
  setReceiptError('');
  status.textContent = '';
});
updateReceiptField();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = validate();
  if (!values) return;

  const button = event.submitter || paymentButtons[1];
  const preferredMethod = button?.dataset.paymentMethod || 'card';
  const originalContent = button.innerHTML;
  paymentButtons.forEach((paymentButton) => { paymentButton.disabled = true; });
  button.textContent = preferredMethod === 'apple_pay' ? 'Opening Apple Pay…' : 'Opening secure card entry…';
  status.textContent = '';

  try {
    const response = await fetch('/api/invoice-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        invoiceId: INVOICE_ID,
        ...values,
        preferredMethod,
        requestId: crypto.randomUUID()
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.url) throw new Error(result.error || 'Checkout could not be started. Please try again.');
    window.location.assign(result.url);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Checkout could not be started. Please try again.';
    paymentButtons.forEach((paymentButton) => { paymentButton.disabled = false; });
    button.innerHTML = originalContent;
  }
});
