const INVOICE_ID = 'LP-AMG-20261027-01';
const INVOICE_AMOUNT = 450_000;
const STRIPE_PUBLISHABLE_KEY = 'pk_live_51UTj2bK6F4IOv7wYekbcGW5wldnACFlgORhTakFKbJGubD9Jni4ztvjilTwc0GguqLg0WMBy1xeRgcT6irb2WBtu00IizVPEG1';
const form = document.querySelector('#payment-form');
const paymentButtons = [...document.querySelectorAll('[data-payment-method]')];
const status = document.querySelector('#form-status');
const canceledNotice = document.querySelector('#canceled-notice');
const sendReceipt = document.querySelector('#send-receipt');
const receiptOptions = document.querySelector('#receipt-options');
const receiptContact = document.querySelector('#receipt-contact');
const receiptContactLabel = document.querySelector('#receipt-contact-label');
const receiptMethodInputs = [...document.querySelectorAll('input[name="receiptMethod"]')];
const walletUnavailable = document.querySelector('#wallet-unavailable');

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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Payment could not be started. Please try again.');
  return result;
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

  const button = event.submitter || paymentButtons[0];
  const originalContent = button.innerHTML;
  paymentButtons.forEach((paymentButton) => { paymentButton.disabled = true; });
  button.textContent = 'Opening secure checkout…';
  status.textContent = '';

  try {
    const result = await postJson('/api/invoice-checkout', {
      invoiceId: INVOICE_ID,
      ...values,
      preferredMethod: 'card',
      requestId: crypto.randomUUID()
    });
    if (!result.url) throw new Error('Checkout could not be started. Please try again.');
    window.location.assign(result.url);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Checkout could not be started. Please try again.';
    paymentButtons.forEach((paymentButton) => { paymentButton.disabled = false; });
    button.innerHTML = originalContent;
  }
});

async function initializeExpressCheckout() {
  if (!window.Stripe) {
    walletUnavailable.hidden = false;
    return;
  }

  const stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY);
  const elements = stripe.elements({
    mode: 'payment',
    amount: INVOICE_AMOUNT,
    currency: 'usd',
    appearance: {
      theme: 'stripe',
      variables: { borderRadius: '12px' }
    }
  });
  const expressCheckout = elements.create('expressCheckout', {
    buttonHeight: 54,
    buttonType: { applePay: 'check-out', googlePay: 'checkout' },
    layout: { maxColumns: 1, maxRows: 2, overflow: 'auto' },
    paymentMethods: { applePay: 'always', googlePay: 'always' }
  });

  expressCheckout.on('ready', ({ availablePaymentMethods }) => {
    walletUnavailable.hidden = Boolean(availablePaymentMethods);
  });

  expressCheckout.on('confirm', async () => {
    const values = validate();
    if (!values) return;
    status.textContent = '';

    try {
      const submitResult = await elements.submit();
      if (submitResult.error) throw new Error(submitResult.error.message);

      const tokenResult = await stripe.createConfirmationToken({
        elements,
        params: { return_url: `${window.location.origin}/payment-success.html` }
      });
      if (tokenResult.error) throw new Error(tokenResult.error.message);

      const requestId = crypto.randomUUID();
      const intent = await postJson('/api/invoice-wallet-intent', {
        action: 'create',
        invoiceId: INVOICE_ID,
        confirmationTokenId: tokenResult.confirmationToken.id,
        ...values,
        requestId
      });

      const confirmation = await stripe.confirmPayment({
        clientSecret: intent.clientSecret,
        confirmParams: { confirmation_token: tokenResult.confirmationToken.id },
        redirect: 'if_required'
      });
      if (confirmation.error) throw new Error(confirmation.error.message);

      if (values.receiptMethod === 'phone') {
        await postJson('/api/invoice-wallet-intent', {
          action: 'send-phone-receipt',
          invoiceId: INVOICE_ID,
          paymentIntentId: confirmation.paymentIntent.id,
          receiptContact: values.receiptContact,
          requestId
        });
      }

      window.location.assign('/payment-success.html');
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Payment could not be completed. Please try again.';
    }
  });

  expressCheckout.mount('#express-checkout-element');
}

initializeExpressCheckout().catch(() => {
  walletUnavailable.hidden = false;
});
