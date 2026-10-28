const INVOICE_ID = 'LP-AMG-20261027-01';
const INVOICE_AMOUNT = 450_000;
const STRIPE_PUBLISHABLE_KEY = 'pk_live_51UTj2bK6F4IOv7wYekbcGW5wldnACFlgORhTakFKbJGubD9Jni4ztvjilTwc0GguqLg0WMBy1xeRgcT6irb2WBtu00IizVPEG1';
const form = document.querySelector('#payment-form');
const payButton = document.querySelector('#pay-button');
const payLabel = document.querySelector('#pay-label');
const cardStage = document.querySelector('#card-stage');
const cardFeedback = document.querySelector('#card-feedback');
let stripe;
let elements;
let paying = false;
let paymentReady = false;
let pendingAttempt;
let currentIntent;
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

document.querySelector('#card-flip').addEventListener('click', (event) => {
  const flipped = cardStage.classList.toggle('is-flipped');
  event.currentTarget.setAttribute('aria-pressed', String(flipped));
});

function setPaying(value) {
  paying = value;
  form.classList.toggle('is-paying', value);
  form.setAttribute('aria-busy', String(value));
  payButton.disabled = value || !paymentReady;
  // Retries reuse the same intent, including its original receipt preference.
  const receiptLocked = value || Boolean(pendingAttempt);
  sendReceipt.disabled = receiptLocked;
  receiptMethodInputs.forEach((input) => { input.disabled = receiptLocked; });
  receiptContact.disabled = receiptLocked || !sendReceipt.checked;
  payLabel.textContent = value ? 'Processing securely…' : 'Pay $4,500.00';
}

function showResult(paymentStatus, receiptWarning = '') {
  const succeeded = paymentStatus === 'succeeded';
  const result = document.createElement('section');
  result.className = 'payment-result';
  result.setAttribute('role', 'status');
  result.innerHTML = `<div class="result-mark" aria-hidden="true">${succeeded ? '✓' : '…'}</div><h2>${succeeded ? 'Payment received.' : 'Payment processing.'}</h2><p>${succeeded ? 'Thank you. Your $4,500.00 payment for invoice LP-AMG-20261027-01 is complete.' : 'Your payment has been submitted. Your bank or payment provider is still processing it. Please do not pay again.'}</p><a href="/">Return to LaunchPoint ↗</a>`;
  if (receiptWarning) {
    const warning = document.createElement('p');
    warning.textContent = receiptWarning;
    result.append(warning);
  }
  form.replaceWith(result);
  result.tabIndex = -1;
  result.focus({ preventScroll: true });
  document.querySelector('.invoice-status').textContent = succeeded ? 'Paid' : 'Processing';
  document.querySelector('.payment-topline > span').textContent = succeeded ? 'Payment received' : 'Payment submitted';
  document.querySelector('.step-current').removeAttribute('aria-current');
  document.querySelector('.step-current').classList.remove('step-current');
  const lastStep = document.querySelector('.checkout-progress > span:last-child');
  lastStep.classList.add('step-current');
  lastStep.setAttribute('aria-current', 'step');
}

async function sendPhoneReceipt(paymentIntent, attempt) {
  if (attempt?.receiptMethod !== 'phone') return '';
  if (paymentIntent.status !== 'succeeded') return 'Your payment is still processing. Contact LaunchPoint for a text receipt after it settles.';
  try {
    await postJson('/api/invoice-wallet-intent', {
      action: 'send-phone-receipt', invoiceId: INVOICE_ID,
      paymentIntentId: paymentIntent.id,
      receiptContact: attempt.receiptContact, requestId: attempt.requestId
    });
    return '';
  } catch {
    return 'Your payment succeeded, but the text receipt could not be delivered. Please contact LaunchPoint for a copy.';
  }
}

async function completePayment() {
  if (paying || !stripe || !elements) return;
  const values = validate();
  if (!values) return;
  setPaying(true);
  status.textContent = '';
  try {
    const submitResult = await elements.submit();
    if (submitResult.error) throw new Error(submitResult.error.message);
    const returnUrl = `${window.location.origin}/invoice/amg`;
    const tokenResult = await stripe.createConfirmationToken({ elements, params: { return_url: returnUrl } });
    if (tokenResult.error) throw new Error(tokenResult.error.message);

    if (!currentIntent) {
      pendingAttempt ||= { action: 'create', invoiceId: INVOICE_ID, confirmationTokenId: tokenResult.confirmationToken.id, ...values, requestId: crypto.randomUUID() };
      currentIntent = await postJson('/api/invoice-wallet-intent', pendingAttempt);
    }

    // Preserve the optional receipt preference across provider authorization redirects.
    try {
      sessionStorage.setItem(`receipt:${currentIntent.paymentIntentId}`, JSON.stringify({
        receiptMethod: pendingAttempt.receiptMethod, receiptContact: pendingAttempt.receiptContact,
        requestId: pendingAttempt.requestId
      }));
    } catch { /* Storage restrictions must never prevent payment. */ }

    const confirmation = await stripe.confirmPayment({
      clientSecret: currentIntent.clientSecret,
      confirmParams: { confirmation_token: tokenResult.confirmationToken.id, return_url: returnUrl },
      redirect: 'if_required'
    });
    if (confirmation.error) throw new Error(confirmation.error.message);
    const paymentStatus = confirmation.paymentIntent?.status;
    if (!['succeeded', 'processing'].includes(paymentStatus)) {
      throw new Error('Your payment needs another step. Please review your payment details.');
    }

    const receiptWarning = await sendPhoneReceipt(confirmation.paymentIntent, pendingAttempt);
    try { sessionStorage.removeItem(`receipt:${confirmation.paymentIntent.id}`); } catch { /* Optional storage. */ }
    showResult(paymentStatus, receiptWarning);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Payment could not be completed. Please try again.';
    setPaying(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  completePayment();
});

async function initializeExpressCheckout() {
  if (!window.Stripe) {
    walletUnavailable.hidden = false;
    document.querySelector('#payment-loading').textContent = 'Secure payment fields could not load. Refresh this page to try again.';
    return;
  }

  stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY);
  const redirectSecret = params.get('payment_intent_client_secret');
  if (redirectSecret) {
    setPaying(true);
    status.textContent = 'Checking your payment…';
    let result;
    try { result = await stripe.retrievePaymentIntent(redirectSecret); } catch { /* Keep payment blocked when verification is unavailable. */ }
    if (!result?.paymentIntent || result.paymentIntent.amount !== INVOICE_AMOUNT || result.paymentIntent.currency !== 'usd') {
      status.textContent = 'We could not verify this payment. Do not pay again. Refresh to check its status or contact LaunchPoint.';
      payLabel.textContent = 'Awaiting payment verification';
      document.querySelector('#payment-loading').hidden = true;
      return;
    }
    if (['succeeded', 'processing'].includes(result.paymentIntent.status)) {
      let savedReceipt;
      try {
        savedReceipt = JSON.parse(sessionStorage.getItem(`receipt:${result.paymentIntent.id}`) || 'null');
        sessionStorage.removeItem(`receipt:${result.paymentIntent.id}`);
      } catch { /* Receipt preference may be unavailable in private browsing. */ }
      const receiptWarning = await sendPhoneReceipt(result.paymentIntent, savedReceipt);
      history.replaceState(null, '', window.location.pathname);
      showResult(result.paymentIntent.status, receiptWarning);
      return;
    }
    if (!['requires_payment_method', 'canceled'].includes(result.paymentIntent.status)) {
      status.textContent = 'This payment still needs verification. Do not pay again. Contact LaunchPoint for help.';
      payLabel.textContent = 'Awaiting payment verification';
      document.querySelector('#payment-loading').hidden = true;
      return;
    }
    history.replaceState(null, '', window.location.pathname);
    setPaying(false);
    status.textContent = result.error?.message || 'Payment was not completed. You can try again below.';
  }
  elements = stripe.elements({
    mode: 'payment',
    amount: INVOICE_AMOUNT,
    currency: 'usd',
    appearance: {
      theme: 'stripe',
      variables: { borderRadius: '12px', colorPrimary: '#b64c11', colorBackground: '#ffffff', colorText: '#292923', colorDanger: '#a9271b', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSizeBase: '16px', spacingUnit: '4px' },
      rules: { '.Input': { border: '1px solid #e1e0d9', boxShadow: 'none', padding: '13px' }, '.Input:focus': { borderColor: '#bf652f', boxShadow: '0 0 0 3px #bf652f18' }, '.Label': { fontWeight: '500', color: '#626259', fontSize: '12px' }, '.Tab': { boxShadow: 'none', border: '1px solid #e1e0d9' }, '.Tab--selected': { borderColor: '#b64c11', backgroundColor: '#fcf5ef' } }
    }
  });
  const expressCheckout = elements.create('expressCheckout', {
    buttonHeight: 54,
    buttonType: { applePay: 'check-out', googlePay: 'checkout' },
    layout: { maxColumns: 2, maxRows: 1, overflow: 'auto' },
    paymentMethods: { applePay: 'always', googlePay: 'always' }
  });

  expressCheckout.on('ready', ({ availablePaymentMethods }) => {
    const hasWallet = Boolean(availablePaymentMethods && Object.values(availablePaymentMethods).some(Boolean));
    walletUnavailable.hidden = hasWallet;
    document.querySelector('#express-checkout-element').hidden = !hasWallet;
    document.querySelector('.payment-divider').hidden = !hasWallet;
  });

  expressCheckout.on('confirm', completePayment);
  expressCheckout.mount('#express-checkout-element');

  const paymentElement = elements.create('payment', {
    layout: { type: 'accordion', defaultCollapsed: false, radios: true, spacedAccordionItems: true },
    fields: { billingDetails: { name: 'auto', email: 'auto', phone: 'auto', address: 'auto' } },
    wallets: { applePay: 'never', googlePay: 'never' }
  });
  paymentElement.on('ready', () => {
    paymentReady = true;
    document.querySelector('#payment-loading').hidden = true;
    payButton.disabled = paying;
  });
  paymentElement.on('focus', () => { cardStage.classList.add('is-focused'); });
  paymentElement.on('blur', () => { cardStage.classList.remove('is-focused'); });
  paymentElement.on('change', (event) => {
    const methods = { card: 'Card', cashapp: 'Cash App Pay', klarna: 'Klarna', us_bank_account: 'Bank account', amazon_pay: 'Amazon Pay', link: 'Link' };
    const label = methods[event.value?.type] || 'Secure payment';
    document.querySelector('#card-method').textContent = label;
    cardStage.classList.toggle('is-complete', event.complete);
    cardFeedback.textContent = event.complete ? `${label} details ready. Confirm when you’re ready.` : 'Your project. One secure payment.';
  });
  paymentElement.mount('#payment-element');
}

initializeExpressCheckout().catch(() => {
  walletUnavailable.hidden = false;
  setPaying(false);
  document.querySelector('#payment-loading').textContent = 'Secure payment fields could not load. Refresh this page to try again.';
});
