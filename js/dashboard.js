(function () {
  const Portal = window.LaunchPointPortal;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = '') => String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[char]));
  let clients = [];
  let activeClientId = null;
  let clientFilter = 'all';
  let session = null;
  let unsubscribeRealtime = null;
  let latestPaymentUrl = '';
  let paymentStatusLoaded = false;

  const headings = {
    overview: ['LaunchPoint / overview', 'The work at a glance.', 'Clients, conversations, and the next decisions in one place.'],
    clients: ['Client roster', 'Every client, one clear view.', 'Track the work, the next decision, and the last conversation.'],
    messages: ['Client care', 'Keep the work moving.', 'Reply without losing the project context around the conversation.'],
    payments: ['LaunchPoint / invoices', 'Create an invoice.', 'A secure payment page for your client, ready in seconds.']
  };

  const activeClient = () => clients.find((client) => client.id === activeClientId) || clients[0];

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  function showAuth(message = '') {
    document.body.dataset.authState = 'signed-out';
    $('#auth-status').textContent = message;
  }

  function setView(view) {
    $$('[data-view-panel]').forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
    $$('.nav-item').forEach((button) => {
      const isActive = button.dataset.view === view;
      button.classList.toggle('is-active', isActive);
      isActive ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
    });
    const [eyebrow, title, description] = headings[view];
    $('#view-eyebrow').textContent = eyebrow;
    $('#view-title').textContent = title;
    $('#view-description').textContent = description;
    $('#new-client-button').hidden = view === 'payments';
    $('#new-invoice-button').hidden = view === 'payments';
    if (view === 'messages') renderMessages();
    if (view === 'clients') renderClients();
    if (view === 'payments') {
      renderRecentPayments();
      if (!paymentStatusLoaded) loadPaymentStatus();
    }
    history.replaceState({}, '', view === 'overview' ? 'dashboard.html' : `dashboard.html?view=${view}`);
  }

  function renderMetrics() {
    const active = clients.filter((client) => client.status !== 'complete').length;
    const unread = clients.reduce((total, client) => total + client.unread, 0);
    $('#active-client-count').textContent = active;
    $('#open-project-count').textContent = clients.filter((client) => client.progress < 100).length;
    $('#unread-message-count').textContent = unread;
    $('#approval-count').textContent = clients.reduce((total, client) => total + client.approvals.filter((approval) => approval.status === 'requested').length, 0);
    $('#nav-client-count').textContent = clients.length;
    $('#nav-unread-count').textContent = unread;
  }

  function renderAttention() {
    const priority = [...clients].sort((a, b) => b.unread - a.unread).slice(0, 4);
    $('#attention-list').innerHTML = priority.length ? priority.map((client, index) => `
      <button class="attention-row" type="button" data-open-client="${client.id}">
        <span class="attention-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="client-mark">${Portal.initials(client.business)}</span>
        <span class="attention-copy"><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(client.project)}</small></span>
        <span class="attention-task">${escapeHtml(client.nextStep)}</span>
        ${client.unread ? `<span class="unread-badge">${client.unread} new</span>` : `<span class="status-chip status-${client.status}">${client.status}</span>`}
        <span class="row-arrow" aria-hidden="true">→</span>
      </button>`).join('') : '<div class="inline-empty">Add your first client to begin.</div>';
  }

  function filteredClients(searchSelector) {
    const query = ($(searchSelector).value || '').trim().toLowerCase();
    return clients.filter((client) => {
      const matchesFilter = clientFilter === 'all' || client.status === clientFilter;
      const haystack = `${client.business} ${client.contact} ${client.project} ${client.nextStep}`.toLowerCase();
      return matchesFilter && haystack.includes(query);
    });
  }

  function renderClients() {
    const visible = filteredClients('#client-search');
    $('#client-table-body').innerHTML = visible.map((client) => `
      <tr data-open-client="${client.id}">
        <td><span class="table-client"><span class="client-mark">${Portal.initials(client.business)}</span><span><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(client.contact)}</small></span></span></td>
        <td>${escapeHtml(client.project)}</td>
        <td><span class="status-chip status-${client.status}">${client.status}</span></td>
        <td>${escapeHtml(client.nextStep)}</td>
        <td>${escapeHtml(client.lastContact)}${client.unread ? `<span class="message-count">${client.unread}</span>` : ''}</td>
        <td><button class="table-open" type="button" aria-label="Open ${escapeHtml(client.business)}">→</button></td>
      </tr>`).join('');
    $('#clients-empty').hidden = visible.length > 0;
  }

  function renderThreadList() {
    const query = ($('#thread-search').value || '').trim().toLowerCase();
    const visible = clients.filter((client) => `${client.business} ${client.contact} ${client.project}`.toLowerCase().includes(query));
    $('#thread-list').innerHTML = visible.map((client) => {
      const last = client.messages[client.messages.length - 1];
      return `<button class="thread-item ${client.id === activeClientId ? 'is-active' : ''}" type="button" data-thread-id="${client.id}">
        <span class="client-mark">${Portal.initials(client.business)}</span>
        <span class="thread-copy"><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(last ? last.body : 'No messages yet')}</small></span>
        <span class="thread-meta"><time>${escapeHtml(client.lastContact)}</time>${client.unread ? `<b>${client.unread}</b>` : ''}</span>
      </button>`;
    }).join('');
  }

  function renderMessages() {
    const client = activeClient();
    renderThreadList();
    const panel = $('#conversation-panel');
    if (!client) {
      panel.hidden = true;
      $('#client-context').innerHTML = '<div class="inline-empty">Add a client to start a conversation.</div>';
      return;
    }
    panel.hidden = false;
    $('#conversation-client-mark').textContent = Portal.initials(client.business);
    $('#conversation-client-name').textContent = client.business;
    $('#conversation-project-name').textContent = client.project;
    $('#composer-client-name').textContent = client.business;
    $('#message-history').innerHTML = client.messages.map((message) => `
      <article class="message-bubble message-${message.sender}"><div><strong>${escapeHtml(message.sender === 'admin' ? 'You' : message.name)}</strong><time>${Portal.formatTime(message.createdAt)}</time></div><p>${escapeHtml(message.body)}</p></article>`
    ).join('') || '<p class="conversation-empty">No messages yet. Send a short welcome note to begin.</p>';
    $('#message-history').scrollTop = $('#message-history').scrollHeight;
    $('#client-context').innerHTML = `
      <p class="section-kicker">Client context</p><h3>${escapeHtml(client.business)}</h3>
      <dl><div><dt>Contact</dt><dd>${escapeHtml(client.contact)}</dd></div><div><dt>Email</dt><dd>${escapeHtml(client.email)}</dd></div><div><dt>Project</dt><dd>${escapeHtml(client.project)}</dd></div><div><dt>Value</dt><dd>${escapeHtml(client.value)}</dd></div><div><dt>Target</dt><dd>${escapeHtml(client.targetDate)}</dd></div></dl>
      <div class="context-progress"><span><b>Progress</b><em>${client.progress}%</em></span><div><i style="width:${client.progress}%"></i></div></div>
      <div class="context-next"><span>Next step</span><strong>${escapeHtml(client.nextStep)}</strong><p>${escapeHtml(client.nextCopy)}</p></div>`;
  }

  async function refresh() {
    clients = await Portal.loadClients();
    if (!activeClientId || !clients.some((client) => client.id === activeClientId)) activeClientId = clients[0]?.id || null;
    renderMetrics(); renderAttention(); renderClients(); renderMessages();
  }

  function recentPayments() {
    try { return JSON.parse(localStorage.getItem('launchpoint-payment-links') || '[]'); }
    catch (_) { return []; }
  }

  function saveRecentPayment(payment) {
    const items = [payment, ...recentPayments().filter((item) => item.url !== payment.url)].slice(0, 8);
    localStorage.setItem('launchpoint-payment-links', JSON.stringify(items));
    renderRecentPayments();
  }

  function renderRecentPayments() {
    const target = $('#recent-payment-list');
    const items = recentPayments();
    target.innerHTML = items.length ? items.map((item) => `
      <article class="recent-payment-item">
        <div><strong>${escapeHtml(item.company)}</strong><span>${escapeHtml(item.description)}</span></div>
        <b>${escapeHtml(item.amount)}</b>
        <time>${escapeHtml(Portal.formatTime(item.createdAt))}</time>
        <button type="button" data-copy-payment="${escapeHtml(item.url)}">Copy</button>
      </article>`).join('') : '<div class="payment-empty"><span>↗</span><p>Your newest invoice links will stay here for quick copying.</p></div>';
  }

  function setIntegrationStatus(id, name, connected) {
    const element = $(id);
    element.classList.toggle('is-connected', connected);
    element.classList.toggle('is-missing', !connected);
    element.innerHTML = `<i></i> ${name} ${connected ? 'connected' : 'setup needed'}`;
  }

  async function loadPaymentStatus() {
    try {
      const status = await Portal.getPaymentIntegrationStatus();
      setIntegrationStatus('#stripe-status', 'Stripe', status.stripeConnected);
      setIntegrationStatus('#quo-status', 'Quo', status.quoConnected);
      paymentStatusLoaded = true;
    } catch (error) {
      setIntegrationStatus('#stripe-status', 'Stripe', false);
      setIntegrationStatus('#quo-status', 'Quo', false);
      $('#payment-form-status').textContent = error.message;
    }
  }

  function showPaymentResult(data, details) {
    latestPaymentUrl = data.url;
    $('#payment-result').hidden = false;
    $('#payment-result-kicker').textContent = data.sent ? 'Sent through Quo' : 'Ready to send';
    $('#payment-result-title').textContent = `${details.company} · ${details.amount}`;
    $('#payment-result-url').href = data.url;
    $('#payment-result-url').textContent = data.url;
    $('#open-payment-link').href = data.url;
    saveRecentPayment({ ...details, url: data.url, sent: Boolean(data.sent), createdAt: new Date().toISOString() });
  }

  async function openClient(id) {
    activeClientId = id;
    setView('messages');
    try { await Portal.markMessagesRead(id); await refresh(); } catch (error) { console.error(error); }
  }

  async function initialize() {
    try {
      session = await Portal.getSession();
      if (!session) return showAuth();
      if (await Portal.getRole() !== 'admin') {
        return showAuth('This email has client access only. Use the client portal link from LaunchPoint.');
      }
      document.body.dataset.authState = 'ready';
      $('#account-email').textContent = session.user.email;
      await refresh();
      unsubscribeRealtime?.();
      unsubscribeRealtime = Portal.subscribe(null, () => {
        clearTimeout(initialize.realtimeTimer);
        initialize.realtimeTimer = setTimeout(() => refresh().catch(console.error), 250);
      });
      const initialView = new URLSearchParams(location.search).get('view');
      setView(['overview', 'clients', 'messages', 'payments'].includes(initialView) ? initialView : 'payments');
    } catch (error) {
      console.error(error);
      showAuth('The workspace could not load. Please try signing in again.');
    }
  }

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true; $('#auth-status').textContent = 'Signing in securely…';
    try {
      await Portal.signInWithPassword(email, password);
      await initialize();
    } catch (error) { $('#auth-status').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('#magic-link-button').addEventListener('click', async (event) => {
    const email = $('#auth-email').value.trim();
    if (!email) return $('#auth-status').textContent = 'Enter your approved email address first.';
    event.currentTarget.disabled = true; $('#auth-status').textContent = 'Sending your secure sign-in link…';
    try {
      await Portal.sendMagicLink(email, new URL('dashboard.html', location.href).href);
      $('#auth-status').textContent = 'Check your email and open the secure link to continue.';
    } catch (error) { $('#auth-status').textContent = error.message; }
    finally { event.currentTarget.disabled = false; }
  });

  $('#sign-out-button').addEventListener('click', async () => { await Portal.signOut(); location.reload(); });
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-view-jump]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewJump)));
  $('#attention-list').addEventListener('click', (event) => { const row = event.target.closest('[data-open-client]'); if (row) openClient(row.dataset.openClient); });
  $('#client-table-body').addEventListener('click', (event) => { const row = event.target.closest('[data-open-client]'); if (row) openClient(row.dataset.openClient); });
  $('#thread-list').addEventListener('click', (event) => { const row = event.target.closest('[data-thread-id]'); if (row) openClient(row.dataset.threadId); });
  $('#client-search').addEventListener('input', renderClients);
  $('#thread-search').addEventListener('input', renderThreadList);
  $$('.filter-button').forEach((button) => button.addEventListener('click', () => {
    clientFilter = button.dataset.clientFilter;
    $$('.filter-button').forEach((item) => item.classList.toggle('is-active', item === button));
    renderClients();
  }));

  $('#message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const client = activeClient(); const input = $('#message-input'); const body = input.value.trim();
    if (!client || !body) return;
    const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
    try {
      await Portal.addMessage(client.id, 'admin', 'LaunchPoint', body);
      input.value = ''; $('#message-status').textContent = 'Delivered securely to the client portal.';
      await refresh(); showToast('Message delivered');
    } catch (error) { $('#message-status').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('#payment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = event.submitter?.value === 'send' ? 'send' : 'generate';
    const form = event.currentTarget;
    const formData = new FormData(form);
    const company = String(formData.get('company') || '').trim();
    const description = String(formData.get('description') || '').trim();
    const amountNumber = Number(formData.get('amount'));
    const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountNumber || 0);
    const phone = String(formData.get('phone') || '').trim();
    if (action === 'send' && !phone) {
      $('#payment-form-status').textContent = 'Add the client mobile number before sending with Quo.';
      $('#payment-phone').focus();
      return;
    }
    const buttons = [$('#generate-payment-link'), $('#send-payment-link')];
    buttons.forEach((button) => { button.disabled = true; });
    $('#payment-form-status').textContent = action === 'send' ? 'Creating the invoice and sending the text…' : 'Creating a secure invoice…';
    try {
      const result = await Portal.createPaymentLink({ company, description, amount: amountNumber, phone, action, requestId: crypto.randomUUID() });
      showPaymentResult(result, { company, description, amount });
      $('#payment-form-status').textContent = result.sent ? 'Invoice sent through Quo.' : 'Invoice ready. Copy the link or open it below.';
      showToast(result.sent ? 'Invoice sent' : 'Invoice created');
    } catch (error) {
      if (error.paymentResult?.url) showPaymentResult(error.paymentResult, { company, description, amount });
      $('#payment-form-status').textContent = error.message;
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
      loadPaymentStatus();
    }
  });

  $('#copy-payment-link').addEventListener('click', async () => {
    if (!latestPaymentUrl) return;
    try { await navigator.clipboard.writeText(latestPaymentUrl); showToast('Payment link copied'); }
    catch (_) { showToast('Open checkout and copy the address'); }
  });

  $('#recent-payment-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-payment]');
    if (!button) return;
    try { await navigator.clipboard.writeText(button.dataset.copyPayment); showToast('Payment link copied'); }
    catch (_) { showToast('Copying is unavailable in this browser'); }
  });

  $('#open-client-portal').addEventListener('click', () => { const client = activeClient(); if (client) window.open(`client.html?id=${encodeURIComponent(client.slug)}`, '_blank', 'noopener'); });
  $('#copy-portal-link').addEventListener('click', async () => {
    const client = activeClient(); if (!client) return;
    const link = new URL(`client.html?id=${encodeURIComponent(client.slug)}`, location.href).href;
    try { await navigator.clipboard.writeText(link); showToast('Secure portal link copied'); }
    catch (_) { showToast('Open the client portal to copy its address'); }
  });

  const dialog = $('#client-dialog');
  $('#new-client-button').addEventListener('click', () => dialog.showModal());
  $('#new-invoice-button').addEventListener('click', () => { setView('payments'); $('#payment-company').focus(); });
  $('#overview-invoice-button').addEventListener('click', () => { setView('payments'); $('#payment-company').focus(); });
  $('#client-form').addEventListener('submit', async (event) => {
    const submitter = event.submitter;
    if (!submitter || submitter.value !== 'save') return;
    event.preventDefault(); submitter.disabled = true;
    const data = new FormData(event.currentTarget);
    try {
      await Portal.createClient(Object.fromEntries(data));
      event.currentTarget.reset(); dialog.close(); await refresh(); showToast('Client added securely');
    } catch (error) { showToast(error.message); }
    finally { submitter.disabled = false; }
  });

  const commandMenu = $('#command-menu');
  function toggleCommands(force) {
    commandMenu.hidden = typeof force === 'boolean' ? !force : !commandMenu.hidden;
    $('#command-button').setAttribute('aria-expanded', String(!commandMenu.hidden));
  }
  $('#command-button').addEventListener('click', () => toggleCommands());
  commandMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-command]'); if (!item) return; toggleCommands(false);
    if (item.dataset.command === 'new-client') dialog.showModal();
    if (item.dataset.command === 'messages') setView('messages');
    if (item.dataset.command === 'payments') setView('payments');
    if (item.dataset.command === 'portal') $('#open-client-portal').click();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); toggleCommands(); }
    if (event.key === 'Escape' && !commandMenu.hidden) toggleCommands(false);
  });

  Portal.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showAuth(); });
  initialize();
})();
