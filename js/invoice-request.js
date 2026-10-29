const STRIPE_PUBLISHABLE_KEY = 'pk_live_51UTj2bK6F4IOv7wYekbcGW5wldnACFlgORhTakFKbJGubD9Jni4ztvjilTwc0GguqLg0WMBy1xeRgcT6irb2WBtu00IizVPEG1';
const invoiceId = location.pathname.split('/').pop() || '';
const $ = (selector) => document.querySelector(selector);
const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const form = $('#payment-form');
const status = $('#form-status');
const payButton = $('#pay-button');
const sendReceipt = $('#send-receipt');
const receiptContact = $('#receipt-contact');
const receiptMethods = [...document.querySelectorAll('input[name="receiptMethod"]')];
let invoice;
let stripe;
let elements;
let paymentReady = false;
let paying = false;
let pendingPhone = '';

async function requestInvoice(method = 'GET', body) {
  const url = method === 'GET' ? `/api/invoice-request?id=${encodeURIComponent(invoiceId)}` : '/api/invoice-request';
  const response = await fetch(url, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: invoiceId, ...body }) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'The invoice could not be loaded.');
  return result;
}

function receiptMethod() {
  return receiptMethods.find((input) => input.checked)?.value || 'email';
}

function updateReceipt() {
  const enabled = sendReceipt.checked;
  const method = receiptMethod();
  $('#receipt-options').hidden = !enabled;
  receiptContact.disabled = !enabled;
  receiptContact.type = method === 'email' ? 'email' : 'tel';
  receiptContact.inputMode = method === 'email' ? 'email' : 'tel';
  receiptContact.autocomplete = method === 'email' ? 'email' : 'tel';
  receiptContact.maxLength = method === 'email' ? 160 : 24;
  $('#receipt-contact-label').textContent = method === 'email' ? 'Email address' : 'Mobile number';
  receiptContact.placeholder = method === 'email' ? 'name@company.com' : '(443) 555-0198';
  receiptContact.value = '';
  $('#receipt-contact-error').textContent = '';
  receiptContact.setAttribute('aria-invalid', 'false');
  status.textContent = '';
}

function selectedReceipt() {
  if (!sendReceipt.checked) return { method: 'none', contact: '' };
  const method = receiptMethod();
  const raw = receiptContact.value.trim();
  const digits = raw.replace(/\D/g, '');
  const contact = method === 'phone' ? (digits.length === 10 ? `+1${digits}` : raw.startsWith('+') ? `+${digits}` : '') : raw.toLowerCase();
  const valid = method === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) : /^\+[1-9]\d{7,14}$/.test(contact);
  if (!valid) {
    $('#receipt-contact-error').textContent = method === 'email' ? 'Enter a valid email address.' : 'Enter a valid mobile number.';
    receiptContact.setAttribute('aria-invalid', 'true');
    receiptContact.focus();
    return null;
  }
  return { method, contact };
}

function setPaying(value) {
  paying = value;
  form.classList.toggle('is-paying', value);
  form.setAttribute('aria-busy', String(value));
  payButton.disabled = value || !paymentReady;
  sendReceipt.disabled = value;
  receiptMethods.forEach((input) => { input.disabled = value; });
  receiptContact.disabled = value || !sendReceipt.checked;
  $('#pay-label').textContent = value ? 'Processing securely…' : `Pay ${money(invoice.amount)}`;
}

function showPaidCard(card) {
  if (!card || !/^[0-9]{4}$/.test(card.last4) || !/^[a-z_]+$/.test(card.brand)) return '';
  const names = { amex: 'American Express', diners: 'Diners Club', discover: 'Discover', jcb: 'JCB', mastercard: 'Mastercard', unionpay: 'UnionPay', visa: 'Visa' };
  const brand = names[card.brand] || 'Card';
  $('#card-stage').classList.remove('is-card-entry', 'is-focused');
  $('#card-stage').classList.add('is-complete', 'is-paid');
  $('#card-entry-label').textContent = `•••• ${card.last4}`;
  $('#card-method').textContent = brand;
  $('#card-feedback').textContent = `Paid with ${brand} ending in ${card.last4}.`;
  return `Paid with ${brand} ending in ${card.last4}.`;
}

function showResult(paymentStatus, warning = '', card = null) {
  const succeeded = paymentStatus === 'succeeded';
  const result = document.createElement('section');
  result.className = 'payment-result';
  result.setAttribute('role', 'status');
  const mark = document.createElement('div');
  mark.className = 'result-mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = succeeded ? '✓' : '…';
  const heading = document.createElement('h2');
  heading.textContent = succeeded ? 'Payment received.' : 'Payment processing.';
  const description = document.createElement('p');
  description.textContent = succeeded
    ? `Thank you. Your ${money(invoice.amount)} payment for invoice ${invoice.reference} is complete.`
    : 'Your payment has been submitted. Your payment provider is still processing it. Please do not pay again.';
  const home = document.createElement('a');
  home.href = '/';
  home.textContent = 'Return to LaunchPoint ↗';
  result.append(mark, heading, description);
  if (succeeded) {
    const download = document.createElement('a');
    download.href = `/api/paid-receipt?id=${encodeURIComponent(invoiceId)}`;
    download.className = 'receipt-download';
    download.textContent = 'Download paid invoice (PDF) ↗';
    result.append(download);
    const paidWith = showPaidCard(card);
    if (paidWith) { const note = document.createElement('p'); note.textContent = paidWith; result.append(note); }
  }
  result.append(home);
  if (warning) { const note = document.createElement('p'); note.textContent = warning; result.append(note); }
  form.replaceWith(result);
  $('#invoice-status').textContent = succeeded ? 'Paid' : 'Processing';
  $('#payment-topline').textContent = succeeded ? 'Payment received' : 'Payment submitted';
  $('.step-current').removeAttribute('aria-current');
  $('.step-current').classList.remove('step-current');
  const finalStep = $('.checkout-progress > span:last-child');
  finalStep.classList.add('step-current');
  finalStep.setAttribute('aria-current', 'step');
}

async function sendPhoneReceipt(phone) {
  if (!phone) return '';
  try {
    await requestInvoice('POST', { action: 'send-phone-receipt', phone });
    try { sessionStorage.removeItem(`invoice-receipt:${invoiceId}`); } catch { /* Receipt storage is optional. */ }
    return '';
  } catch {
    return 'Your payment succeeded, but the text receipt could not be sent. Contact LaunchPoint for a copy.';
  }
}

async function completePayment() {
  if (paying || !stripe || !elements) return;
  const receipt = selectedReceipt();
  if (!receipt) return;
  pendingPhone = receipt.method === 'phone' ? receipt.contact : '';
  if (!pendingPhone) {
    try { sessionStorage.removeItem(`invoice-receipt:${invoiceId}`); } catch { /* Receipt storage is optional. */ }
  }
  setPaying(true);
  status.textContent = '';
  try {
    const submitted = await elements.submit();
    if (submitted.error) throw new Error(submitted.error.message);
    if (receipt.method === 'email') await requestInvoice('POST', { action: 'set-email', email: receipt.contact });
    if (receipt.method === 'phone') {
      await requestInvoice('POST', { action: 'set-phone', phone: receipt.contact });
      pendingPhone = receipt.contact;
      try { sessionStorage.setItem(`invoice-receipt:${invoiceId}`, receipt.contact); } catch { /* Payment must not depend on browser storage. */ }
    }
    const confirmation = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: location.href.split('?')[0] },
      redirect: 'if_required'
    });
    if (confirmation.error) throw new Error(confirmation.error.message);
    if (!['succeeded', 'processing'].includes(confirmation.paymentIntent?.status)) {
      throw new Error('Your payment needs another step. Please review your payment details.');
    }
    const warning = confirmation.paymentIntent.status === 'succeeded' && pendingPhone
      ? await sendPhoneReceipt(pendingPhone) : '';
    let card = null;
    if (confirmation.paymentIntent.status === 'succeeded') {
      try { card = (await requestInvoice()).card; } catch { /* Payment confirmation must remain visible. */ }
    }
    showResult(confirmation.paymentIntent.status, warning, card);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Payment could not be completed. Please try again.';
    setPaying(false);
  }
}

function renderInvoice() {
  const amount = money(invoice.amount);
  document.title = `${invoice.company} invoice | LaunchPoint`;
  $('#header-reference').textContent = invoice.reference;
  $('#invoice-title').textContent = `${invoice.company} invoice`;
  $('#invoice-summary').textContent = invoice.description;
  $('#card-company').textContent = invoice.company;
  $('#card-back-company').textContent = `${invoice.company} · Secure checkout`;
  $('#bill-to-company').textContent = invoice.company;
  $('#invoice-date').textContent = new Date(invoice.created * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  $('#service-description').textContent = invoice.description;
  $('#service-amount').textContent = amount;
  $('#invoice-total').textContent = amount;
  $('#payment-amount').textContent = amount;
  $('#pay-label').textContent = `Pay ${amount}`;
  $('#invoice-load-message').hidden = true;
  $('#invoice-shell').hidden = false;
}

async function initialize() {
  if (!/^pi_[A-Za-z0-9_]{10,80}$/.test(invoiceId)) throw new Error('Invoice not found.');
  invoice = await requestInvoice();
  renderInvoice();
  if (invoice.status === 'succeeded' || invoice.status === 'processing') {
    let savedPhone = '';
    try { savedPhone = sessionStorage.getItem(`invoice-receipt:${invoiceId}`) || ''; } catch { /* Receipt storage is optional. */ }
    const warning = invoice.status === 'succeeded' ? await sendPhoneReceipt(savedPhone) : '';
    showResult(invoice.status, warning, invoice.card);
    return;
  }
  if (invoice.status !== 'requires_payment_method' || !invoice.clientSecret) {
    $('#payment-loading').textContent = 'This invoice is not available for payment. Contact LaunchPoint for help.';
    return;
  }
  if (!window.Stripe) throw new Error('Secure payment fields could not load. Refresh this page to try again.');
  stripe = window.Stripe(STRIPE_PUBLISHABLE_KEY);
  elements = stripe.elements({
    clientSecret: invoice.clientSecret,
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
    $('#wallet-unavailable').hidden = hasWallet;
    $('#express-checkout-element').hidden = !hasWallet;
    $('.payment-divider').hidden = !hasWallet;
  });
  expressCheckout.on('confirm', completePayment);
  expressCheckout.mount('#express-checkout-element');
  const paymentElement = elements.create('payment', {
    layout: { type: 'accordion', defaultCollapsed: false, radios: true, spacedAccordionItems: true },
    fields: { billingDetails: { name: 'auto', email: 'auto', phone: 'auto', address: 'auto' } },
    wallets: { applePay: 'never', googlePay: 'never' }
  });
  let selectedMethod = 'card';
  let detailsComplete = false;
  let cardHasInput = false;
  const cardStage = $('#card-stage');
  const cardEntryLabel = $('#card-entry-label');
  const updateCardEntry = () => {
    const cardSelected = selectedMethod === 'card';
    const entering = cardSelected && !detailsComplete && (cardStage.classList.contains('is-focused') || cardHasInput);
    cardStage.classList.toggle('is-card-entry', entering);
    cardStage.classList.toggle('is-complete', cardSelected && detailsComplete);
    cardEntryLabel.textContent = cardSelected
      ? detailsComplete ? 'Card details ready' : entering ? 'Secure card entry in progress' : 'Card details stay protected'
      : 'Payment details stay protected';
  };
  paymentElement.on('ready', () => { paymentReady = true; $('#payment-loading').hidden = true; payButton.disabled = false; });
  paymentElement.on('focus', () => { cardStage.classList.add('is-focused'); updateCardEntry(); });
  paymentElement.on('blur', () => { cardStage.classList.remove('is-focused'); updateCardEntry(); });
  paymentElement.on('change', (event) => {
    const methods = { card: 'Card', cashapp: 'Cash App Pay', klarna: 'Klarna', us_bank_account: 'Bank account', amazon_pay: 'Amazon Pay', link: 'Link' };
    selectedMethod = event.value?.type || 'card';
    detailsComplete = Boolean(event.complete);
    cardHasInput = selectedMethod === 'card' && event.empty === false;
    const label = methods[selectedMethod] || 'Secure payment';
    $('#card-method').textContent = label;
    updateCardEntry();
    $('#card-feedback').textContent = event.complete ? `${label} details ready. Confirm when you’re ready.` : 'Your project. One secure payment.';
  });
  paymentElement.mount('#payment-element');
}

sendReceipt.addEventListener('change', updateReceipt);
receiptMethods.forEach((input) => input.addEventListener('change', updateReceipt));
receiptContact.addEventListener('input', () => { $('#receipt-contact-error').textContent = ''; receiptContact.setAttribute('aria-invalid', 'false'); status.textContent = ''; });
updateReceipt();
$('#card-flip').addEventListener('click', (event) => { const flipped = $('#card-stage').classList.toggle('is-flipped'); event.currentTarget.setAttribute('aria-pressed', String(flipped)); });
form.addEventListener('submit', (event) => { event.preventDefault(); completePayment(); });
initialize().catch((error) => {
  $('#invoice-load-message').hidden = false;
  $('#invoice-load-message').textContent = error instanceof Error ? error.message : 'The invoice could not be loaded.';
  $('#invoice-shell').hidden = true;
});
