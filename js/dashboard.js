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
  let invoiceHistory = [];
  let recentPaid = [];
  let invoiceHistoryError = '';
  let paymentRefreshTimer = null;
  let renderedProjectId = null;
  const projectDrafts = new Map();
  const savingProjects = new Set();
  const savingRequests = new Set();
  const invitingClients = new Set();
  const uploadingClients = new Set();
  const syncingSubscriptions = new Set();
  const projectNotices = new Map();
  const projectFields = ['business', 'contact', 'email', 'project', 'status', 'summary', 'nextStep', 'nextCopy', 'targetDate', 'supportPlan', 'stripeSubscriptionId'];
  const requestStates = { submitted: 'Submitted', in_progress: 'In progress', needs_info: 'Needs information', completed: 'Completed' };
  const formatMoney = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

  const headings = {
    overview: ['LaunchPoint / home', 'Your business, today.', 'Payments, clients, and the next move in one place.'],
    clients: ['Client roster', 'Every client, one clear view.', 'Track the work, the next decision, and the last conversation.'],
    messages: ['Client care', 'Keep the work moving.', 'Reply without losing the project context around the conversation.'],
    payments: ['LaunchPoint / invoices', 'Create an invoice.', 'A secure payment page for your client, ready in seconds.'],
    project: ['LaunchPoint / projects', 'Keep everyone in the loop.', 'Progress, client feedback, and shared files — from kickoff to ongoing support.']
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
      const isActive = button.dataset.view === view || (view === 'project' && button.dataset.view === 'clients');
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
    if (view === 'project') renderProject();
    if (view === 'overview') {
      renderRecentPaid();
      loadPaymentStatus();
    }
    if (view === 'payments') {
      renderRecentPayments();
      loadPaymentStatus();
    }
    const projectQuery = view === 'project' && activeClientId ? `&client=${encodeURIComponent(activeClientId)}` : '';
    history.replaceState({}, '', view === 'overview' ? 'dashboard.html' : `dashboard.html?view=${view}${projectQuery}`);
  }

  function renderMetrics() {
    const active = clients.filter((client) => client.status === 'active').length;
    const unread = clients.reduce((total, client) => total + client.unread, 0);
    $('#active-client-count').textContent = active;
    $('#open-project-count').textContent = clients.filter((client) => client.status !== 'complete').length;
    $('#unread-message-count').textContent = unread;
    $('#approval-count').textContent = clients.reduce((total, client) => total + client.approvals.filter((approval) => approval.status === 'requested').length, 0);
    $('#nav-client-count').textContent = clients.length;
    $('#nav-unread-count').textContent = unread;
  }

  function renderAttention() {
    const needsAttention = (client) => (client.requests || []).filter((request) => request.status === 'submitted').length + client.unread;
    const priority = clients.filter((client) => client.status !== 'untracked').sort((a, b) => needsAttention(b) - needsAttention(a)).slice(0, 4);
    $('#attention-list').innerHTML = priority.length ? priority.map((client, index) => `
      <button class="attention-row" type="button" data-open-client="${client.id}">
        <span class="attention-number">${String(index + 1).padStart(2, '0')}</span>
        <span class="client-mark">${Portal.initials(client.business)}</span>
        <span class="attention-copy"><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(client.project)}</small></span>
        <span class="attention-task">${(client.requests || []).some((request) => request.status === 'submitted') ? `${(client.requests || []).filter((request) => request.status === 'submitted').length} new edit request(s)` : escapeHtml(client.nextStep)}</span>
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
        <td><span class="table-client"><span class="client-mark">${Portal.initials(client.business)}</span><span><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(client.contact || 'Contact not added')}</small></span></span></td>
        <td>${escapeHtml(client.project)}</td>
        <td><span class="status-chip status-${client.status}">${client.status}</span></td>
        <td>${escapeHtml(client.nextStep)}</td>
        <td>${escapeHtml(client.lastContact)}${client.unread ? `<span class="message-count">${client.unread}</span>` : ''}</td>
        <td><button class="table-open" type="button" aria-label="Open project workspace for ${escapeHtml(client.business)}">→</button></td>
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
    const canMessage = Boolean(client.email);
    $('#message-input').disabled = !canMessage;
    $('#message-form [type="submit"]').disabled = !canMessage;
    $('#message-status').textContent = canMessage ? '' : 'Add a client email before using portal messages.';
    $('#copy-portal-link').disabled = !canMessage;
    $('#open-client-portal').disabled = !canMessage;
    $('#message-history').innerHTML = client.messages.map((message) => `
      <article class="message-bubble message-${message.sender}"><div><strong>${escapeHtml(message.sender === 'admin' ? 'You' : message.name)}</strong><time>${Portal.formatTime(message.createdAt)}</time></div><p>${escapeHtml(message.body)}</p></article>`
    ).join('') || '<p class="conversation-empty">No messages yet. Send a short welcome note to begin.</p>';
    $('#message-history').scrollTop = $('#message-history').scrollHeight;
    $('#client-context').innerHTML = `
      <p class="section-kicker">Client context</p><h3>${escapeHtml(client.business)}</h3>
      <dl><div><dt>Contact</dt><dd>${escapeHtml(client.contact || 'Not added')}</dd></div><div><dt>Email</dt><dd>${escapeHtml(client.email || 'Not added')}</dd></div><div><dt>Project</dt><dd>${escapeHtml(client.project)}</dd></div><div><dt>Value</dt><dd>${escapeHtml(client.value)}</dd></div><div><dt>Target</dt><dd>${escapeHtml(client.targetDate)}</dd></div></dl>
      <div class="context-progress"><span><b>Progress</b><em>${client.progress == null ? 'Not tracked' : `${client.progress}%`}</em></span><div><i style="width:${client.progress ?? 0}%"></i></div></div>
      <div class="context-next"><span>Next step</span><strong>${escapeHtml(client.nextStep)}</strong><p>${escapeHtml(client.nextCopy)}</p></div>`;
  }

  const portalUrl = (client) => new URL(`client.html?id=${encodeURIComponent(client.slug)}`, location.href).href;
  const projectForm = () => $('#project-form');
  const formField = (name) => projectForm().elements.namedItem(name);
  const readableSize = (size) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;

  function readProjectDraft() {
    const draft = Object.fromEntries(projectFields.map((name) => [name, formField(name).value.trim()]));
    draft.milestones = $$('.project-milestone-row', projectForm()).map((row, position) => ({
      ...(row.dataset.milestoneId ? { id: row.dataset.milestoneId } : {}),
      label: $('[data-milestone-label]', row).value.trim(), state: $('[data-milestone-state]', row).value, position
    }));
    return draft;
  }

  function rememberProjectDraft() {
    if (!renderedProjectId) return;
    projectDrafts.set(renderedProjectId, readProjectDraft());
    $('#project-draft-state').textContent = 'Unsaved changes';
    $('#project-save-status').textContent = '';
    $('#revert-project').disabled = false;
  }

  function milestoneRow(item, index) {
    return `<div class="project-milestone-row"${item.id ? ` data-milestone-id="${escapeHtml(item.id)}"` : ''}>
      <span class="project-step-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <label><span class="sr-only">Step ${index + 1} name</span><input data-milestone-label required maxlength="120" value="${escapeHtml(item.label)}" placeholder="Name this step"></label>
      <label><span class="sr-only">Step ${index + 1} status</span><select data-milestone-state>${Object.entries({ upcoming: 'Upcoming', current: 'In progress', complete: 'Complete' }).map(([value, label]) => `<option value="${value}"${item.state === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
      <button type="button" class="project-remove-step" data-remove-milestone aria-label="Remove step ${index + 1}">×</button>
    </div>`;
  }

  function renderProjectEditor(client, force = false) {
    if (renderedProjectId !== client.id || force) {
      const switchedClient = renderedProjectId !== client.id;
      const draft = projectDrafts.get(client.id) || client;
      projectFields.forEach((name) => { formField(name).value = draft[name] || ''; });
      $('#project-milestone-editor').innerHTML = (draft.milestones || []).map(milestoneRow).join('') || '<p class="project-empty-steps">Add the steps your client will follow from kickoff to launch.</p>';
      renderedProjectId = client.id;
      $('#project-save-status').textContent = '';
      if (switchedClient) {
        $('#project-upload').value = '';
        $('#project-upload-status').textContent = '';
        $('#project-request-status').textContent = '';
        $('#project-subscription-message').textContent = '';
      }
    }
    $('#project-draft-state').textContent = projectDrafts.has(client.id) ? 'Unsaved changes' : 'Saved';
    $('#project-fields').disabled = savingProjects.has(client.id);
    $('#save-project').disabled = savingProjects.has(client.id);
    $('#revert-project').disabled = savingProjects.has(client.id) || !projectDrafts.has(client.id);
    $('#add-project-milestone').disabled = savingProjects.has(client.id) || $$('.project-milestone-row', projectForm()).length >= 12;
  }

  function renderProjectRequests(client) {
    const requests = client.requests || [];
    $('#project-request-count').textContent = requests.length ? `(${requests.length})` : '';
    $('#project-request-list').innerHTML = requests.length ? requests.map((request) => {
      const attachments = (client.files || []).filter((file) => file.requestId === request.id);
      let pageLink = '';
      try {
        const url = new URL(request.pageUrl);
        if (['https:', 'http:'].includes(url.protocol)) pageLink = `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">View referenced page ↗</a>`;
      } catch (_) { /* An edit does not have to reference a page. */ }
      return `<article class="project-request-item"><div class="project-request-top"><div><h4>${escapeHtml(request.title)}</h4><time datetime="${escapeHtml(request.createdAt)}">${escapeHtml(Portal.formatTime(request.createdAt))}</time></div><label><span class="sr-only">Status for ${escapeHtml(request.title)}</span><select data-request-status="${escapeHtml(request.id)}"${savingRequests.has(request.id) ? ' disabled' : ''}>${Object.entries(requestStates).map(([value, label]) => `<option value="${value}"${request.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label></div><p>${escapeHtml(request.description)}</p>${pageLink}${attachments.length ? `<div class="project-request-attachments">${attachments.map((file) => `<button type="button" data-project-file="${escapeHtml(file.id)}">↗ ${escapeHtml(file.filename)}</button>`).join('')}</div>` : ''}</article>`;
    }).join('') : '<div class="project-empty"><span aria-hidden="true">↗</span><h4>No edit requests yet</h4><p>Send the portal link so your client can leave their first round of feedback here.</p></div>';
  }

  function renderProjectFiles(client) {
    const files = client.files || [];
    $('#project-file-count').textContent = files.length;
    $('#project-file-list').innerHTML = files.length ? files.map((file) => `<button class="project-file-item" type="button" data-project-file="${escapeHtml(file.id)}"><span class="project-file-type">${escapeHtml(file.filename.split('.').pop().slice(0, 5).toUpperCase())}</span><span><strong>${escapeHtml(file.filename)}</strong><small>${readableSize(file.size)} · ${escapeHtml(Portal.formatTime(file.createdAt))}</small></span><span aria-hidden="true">↗</span></button>`).join('') : '<p class="project-file-empty">Shared files will appear here. Downloads are private to this project.</p>';
  }

  function renderProject(force = false) {
    const client = activeClient();
    if (!client) return;
    $('#project-business-name').textContent = client.business;
    $('#project-project-name').textContent = client.project;
    $('#project-message-count').textContent = client.unread ? `(${client.unread} new)` : '';
    const statusLabels = { active: 'In progress', waiting: 'Waiting for client', complete: 'Complete', untracked: 'Not yet tracked' };
    $('#project-badges').innerHTML = `<span class="status-chip status-${escapeHtml(client.status)}">${escapeHtml(statusLabels[client.status] || client.status)}</span><span class="project-access-badge">${client.canSubmitEdits ? 'Edits open' : 'Edits closed'}</span>${client.supportStatus === 'active' ? '<span class="project-access-badge">Ongoing support</span>' : ''}`;
    $('#project-progress').value = client.progress || 0;
    $('#project-progress-label').textContent = client.progress == null ? 'Progress not tracked' : `${client.progress}% complete`;
    $('#project-progress-copy').textContent = client.milestones.length ? `${client.milestones.filter((step) => step.state === 'complete').length} of ${client.milestones.length} milestones complete` : 'Add milestones below to start tracking progress.';
    $('#project-portal-url').value = portalUrl(client);
    $('#project-email-invite').disabled = !client.email || savingProjects.has(client.id) || invitingClients.has(client.id);
    $('#project-upload').disabled = uploadingClients.has(client.id);
    $('#project-upload-form [type="submit"]').disabled = uploadingClients.has(client.id);
    $('#project-access-note').textContent = client.email ? `Only ${client.email} can sign in as this client. Save email changes before sending an invitation.` : 'Add and save the client email to enable their private portal access.';
    $('#project-invite-status').textContent = projectNotices.get(client.id) || '';
    $('#project-subscription-state').textContent = client.stripeSubscriptionId ? `Stripe status: ${client.subscriptionStatus || 'Not verified yet'}` : 'No subscription linked';
    $('#project-subscription-check').textContent = client.subscriptionCheckedAt ? `Status checked ${Portal.formatTime(client.subscriptionCheckedAt)}` : 'Save the subscription ID, then sync to verify paid access.';
    $('#project-sync-subscription').disabled = !client.stripeSubscriptionId || syncingSubscriptions.has(client.id) || savingProjects.has(client.id);
    renderProjectEditor(client, force);
    renderProjectRequests(client);
    renderProjectFiles(client);
  }

  function openProject(id) {
    if (!clients.some((client) => client.id === id)) return;
    activeClientId = id;
    setView('project');
  }

  async function refresh() {
    clients = await Portal.loadClients();
    if (!activeClientId || !clients.some((client) => client.id === activeClientId)) activeClientId = clients[0]?.id || null;
    renderMetrics(); renderAttention(); renderClients(); renderMessages();
    if (!$('#project-view').hidden) renderProject();
  }

  function saveRecentPayment(payment) {
    invoiceHistory = [payment, ...invoiceHistory.filter((item) => item.url !== payment.url)].slice(0, 8);
    invoiceHistoryError = '';
    renderRecentPayments();
  }

  function renderRecentPayments() {
    const target = $('#recent-payment-list');
    const items = invoiceHistory;
    target.innerHTML = items.length ? items.map((item) => `
      <article class="recent-payment-item">
        <div><strong>${escapeHtml(item.company)}</strong><span>${escapeHtml(item.description)}</span></div>
        <b>${escapeHtml(item.amount)}</b>
        <time>${escapeHtml(Portal.formatTime(item.createdAt))} · ${escapeHtml(item.status || 'Open')}</time>
        <button type="button" data-copy-payment="${escapeHtml(item.url)}">Copy</button>
      </article>`).join('') : `<div class="payment-empty"><span>↗</span><p>${escapeHtml(invoiceHistoryError || 'Your newest invoices will appear here after they are created.')}</p></div>`;
  }

  function renderRecentPaid() {
    const target = $('#recent-paid-list');
    target.innerHTML = recentPaid.length ? recentPaid.map((item) => `
      <a class="paid-invoice-row" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">
        <span><strong>${escapeHtml(item.company)}</strong><small>${escapeHtml(item.description)}</small></span>
        <span><b>${escapeHtml(item.amount)}</b><small>Invoice created ${escapeHtml(Portal.formatTime(item.createdAt))}</small></span>
      </a>`).join('') : `<p class="inline-empty">${escapeHtml(invoiceHistoryError || 'No paid LaunchPoint invoices in recent Stripe history yet.')}</p>`;
  }

  function renderFinanceSummary(summary, error = '') {
    $('#gross-revenue').textContent = summary ? formatMoney(summary.grossReceived) : '—';
    $('#paid-invoice-count').textContent = summary ? summary.paidCount : '—';
    $('#open-invoice-amount').textContent = summary ? formatMoney(summary.openAmount) : '—';
    $('#open-invoice-count').textContent = summary ? `${summary.openCount} awaiting payment` : 'Waiting for payment';
    $('#processing-invoice-amount').textContent = summary ? formatMoney(summary.processingAmount) : '—';
    $('#processing-invoice-count').textContent = summary ? `${summary.processingCount} processing` : 'Not counted as paid';
    $('#revenue-scope').textContent = error || (summary?.complete
      ? 'All LaunchPoint invoices in this Stripe account. Gross before refunds and fees.'
      : summary ? `Based on the newest ${summary.scannedCount} Stripe payments. Older history is not included.` : 'Stripe payment history is unavailable.');
    $('#revenue-updated').textContent = summary ? `Updated ${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date())}` : '';
  }

  function renderRevenueChart() {
    const chart = $('#revenue-chart');
    const items = invoiceHistory
      .filter((item) => item.status !== 'Canceled' && Number.isFinite(item.cents))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .reverse();
    chart.hidden = items.length < 2;
    if (chart.hidden) return;
    const peak = Math.max(...items.map((item) => item.cents));
    const paid = items.filter((item) => item.status === 'Paid');
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
    $('#revenue-chart-title').textContent = `Last ${items.length} invoices`;
    $('#revenue-bars').setAttribute('aria-label', `Last ${items.length} invoices: ${paid.length} paid, totaling ${formatMoney(paid.reduce((sum, item) => sum + item.cents, 0))}.`);
    $('#revenue-bars').innerHTML = items.map((item) => {
      const tone = item.status === 'Paid' ? 'is-paid' : item.status === 'Processing' ? 'is-processing' : 'is-open';
      const height = Math.max(6, Math.round((item.cents / peak) * 100));
      return `<span class="revenue-bar ${tone}" style="--h:${height}%" title="${escapeHtml(item.company)} · ${escapeHtml(item.amount)} · ${item.status}"><i></i><small>${day.format(new Date(item.createdAt))}</small></span>`;
    }).join('');
  }

  function setIntegrationStatus(id, name, connected) {
    const element = $(id);
    element.classList.toggle('is-connected', connected);
    element.classList.toggle('is-missing', !connected);
    element.innerHTML = `<i></i> ${name} ${connected ? (name === 'Quo' ? 'configured' : 'connected') : 'setup needed'}`;
  }

  async function loadPaymentStatus() {
    const refreshButton = $('#refresh-revenue');
    refreshButton.disabled = true;
    try {
      const status = await Portal.getPaymentIntegrationStatus();
      setIntegrationStatus('#stripe-status', 'Stripe', status.stripeConnected);
      setIntegrationStatus('#quo-status', 'Quo', status.quoConnected);
      invoiceHistoryError = status.historyError || '';
      const mapInvoice = (item) => ({
        company: item.company,
        description: item.description,
        amount: formatMoney(item.amount),
        cents: item.amount,
        createdAt: new Date(item.created * 1000).toISOString(),
        status: item.status === 'succeeded' ? 'Paid' : item.status === 'processing' ? 'Processing' : item.status === 'canceled' ? 'Canceled' : 'Open',
        url: new URL(item.url?.startsWith('/invoice/') ? item.url : `/invoice/${encodeURIComponent(item.id)}`, location.origin).href
      });
      invoiceHistory = (status.recentInvoices || []).map(mapInvoice);
      recentPaid = (status.recentPaid || []).map(mapInvoice);
      renderFinanceSummary(status.summary, invoiceHistoryError || (!status.stripeConnected ? 'Connect Stripe to see payments and revenue.' : ''));
      renderRecentPayments();
      renderRecentPaid();
      renderRevenueChart();
    } catch (error) {
      $('#revenue-chart').hidden = true;
      setIntegrationStatus('#stripe-status', 'Stripe', false);
      setIntegrationStatus('#quo-status', 'Quo', false);
      invoiceHistoryError = 'Payment history could not load.';
      renderFinanceSummary(null, invoiceHistoryError);
      renderRecentPaid();
      $('#payment-form-status').textContent = error.message;
    } finally {
      refreshButton.disabled = false;
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
      const params = new URLSearchParams(location.search);
      const initialView = params.get('view');
      if (initialView === 'project' && clients.some((client) => client.id === params.get('client'))) activeClientId = params.get('client');
      setView(['overview', 'clients', 'messages', 'payments', ...(clients.length ? ['project'] : [])].includes(initialView) ? initialView : 'overview');
      clearInterval(paymentRefreshTimer);
      paymentRefreshTimer = setInterval(() => {
        if (!document.hidden && !$('#overview-view').hidden) loadPaymentStatus();
      }, 60_000);
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
  $('#refresh-revenue').addEventListener('click', loadPaymentStatus);
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-view-jump]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewJump)));
  $('#attention-list').addEventListener('click', (event) => { const row = event.target.closest('[data-open-client]'); if (row) openProject(row.dataset.openClient); });
  $('#client-table-body').addEventListener('click', (event) => { const row = event.target.closest('[data-open-client]'); if (row) openProject(row.dataset.openClient); });
  $('#thread-list').addEventListener('click', (event) => { const row = event.target.closest('[data-thread-id]'); if (row) openClient(row.dataset.threadId); });
  $('#client-search').addEventListener('input', renderClients);
  $('#thread-search').addEventListener('input', renderThreadList);
  $$('.filter-button').forEach((button) => button.addEventListener('click', () => {
    clientFilter = button.dataset.clientFilter;
    $$('.filter-button').forEach((item) => item.classList.toggle('is-active', item === button));
    renderClients();
  }));

  projectForm().addEventListener('input', rememberProjectDraft);
  projectForm().addEventListener('change', rememberProjectDraft);
  $('#add-project-milestone').addEventListener('click', () => {
    const editor = $('#project-milestone-editor');
    const rows = $$('.project-milestone-row', editor);
    if (rows.length >= 12) return;
    $('.project-empty-steps', editor)?.remove();
    editor.insertAdjacentHTML('beforeend', milestoneRow({ label: '', state: 'upcoming' }, rows.length));
    rememberProjectDraft();
    $('#add-project-milestone').disabled = rows.length + 1 >= 12;
    $$('.project-milestone-row input', editor).at(-1).focus();
  });
  $('#project-milestone-editor').addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-milestone]');
    if (!button) return;
    button.closest('.project-milestone-row').remove();
    rememberProjectDraft();
    $('#project-milestone-editor').innerHTML = readProjectDraft().milestones.map(milestoneRow).join('') || '<p class="project-empty-steps">Add the steps your client will follow from kickoff to launch.</p>';
    $('#add-project-milestone').disabled = false;
  });
  $('#revert-project').addEventListener('click', () => {
    const client = activeClient(); if (!client) return;
    projectDrafts.delete(client.id);
    renderProject(true);
  });
  projectForm().addEventListener('submit', async (event) => {
    event.preventDefault();
    const client = activeClient();
    if (!client || savingProjects.has(client.id)) return;
    const draft = readProjectDraft();
    savingProjects.add(client.id);
    renderProjectEditor(client);
    $('#project-save-status').textContent = 'Saving the project and progress tracker…';
    try {
      await Portal.updateProject(client.id, draft);
      projectDrafts.delete(client.id);
      await refresh();
      if (activeClientId === client.id) {
        renderProject(true);
        $('#project-save-status').textContent = 'Saved. These updates are now available in the client portal.';
      }
      showToast('Project updated');
    } catch (error) {
      if (activeClientId === client.id) $('#project-save-status').textContent = error.message;
      else showToast(`Could not save ${client.business}: ${error.message}`);
    } finally {
      savingProjects.delete(client.id);
      if (activeClientId === client.id) renderProject();
    }
  });
  $('#project-messages-button').addEventListener('click', () => { const client = activeClient(); if (client) openClient(client.id); });
  $('#conversation-open-project').addEventListener('click', () => { const client = activeClient(); if (client) openProject(client.id); });
  $('#message-project-files').addEventListener('click', () => {
    const client = activeClient(); if (!client) return;
    openProject(client.id);
    $('#project-upload').focus();
  });
  $('#project-copy-link').addEventListener('click', async () => {
    const client = activeClient(); if (!client) return;
    try { await navigator.clipboard.writeText(portalUrl(client)); showToast('Private portal link copied'); }
    catch (_) { $('#project-portal-url').focus(); $('#project-portal-url').select(); showToast('Select and copy the portal address'); }
  });
  $('#project-open-portal').addEventListener('click', () => { const client = activeClient(); if (client) window.open(portalUrl(client), '_blank', 'noopener'); });
  $('#project-email-invite').addEventListener('click', async () => {
    const client = activeClient(); if (!client?.email || invitingClients.has(client.id)) return;
    if (formField('email').value.trim().toLowerCase() !== client.email.toLowerCase()) {
      projectNotices.set(client.id, 'Save the client email changes before sending an invitation.');
      renderProject();
      return;
    }
    invitingClients.add(client.id);
    projectNotices.set(client.id, 'Sending the secure sign-in invitation…');
    renderProject();
    try {
      await Portal.sendMagicLink(client.email, portalUrl(client));
      projectNotices.set(client.id, `Invitation sent to ${client.email}. The client can open their secure email link to sign in.`);
    } catch (error) {
      projectNotices.set(client.id, `Invitation could not be sent: ${error.message} You can still copy the portal link above.`);
    } finally {
      invitingClients.delete(client.id);
      if (activeClientId === client.id) renderProject();
    }
  });
  $('#project-sync-subscription').addEventListener('click', async () => {
    const client = activeClient(); if (!client?.stripeSubscriptionId || syncingSubscriptions.has(client.id)) return;
    if (formField('stripeSubscriptionId').value.trim() !== client.stripeSubscriptionId || formField('email').value.trim() !== client.email) {
      $('#project-subscription-message').textContent = 'Save the email and subscription ID changes before syncing with Stripe.';
      return;
    }
    syncingSubscriptions.add(client.id);
    $('#project-subscription-message').textContent = 'Checking the saved subscription with Stripe…';
    renderProject();
    try {
      await Portal.syncSubscription(client.id);
      await refresh();
      if (activeClientId === client.id) $('#project-subscription-message').textContent = 'Subscription checked. Client edit access reflects the verified payment status.';
    } catch (error) {
      if (activeClientId === client.id) $('#project-subscription-message').textContent = error.message;
      else showToast(error.message);
    } finally {
      syncingSubscriptions.delete(client.id);
      if (activeClientId === client.id) renderProject();
    }
  });
  $('#project-request-list').addEventListener('change', async (event) => {
    const select = event.target.closest('[data-request-status]');
    if (!select) return;
    const clientId = activeClientId;
    const requestId = select.dataset.requestStatus;
    savingRequests.add(requestId); select.disabled = true;
    $('#project-request-status').textContent = 'Updating request status…';
    try {
      await Portal.updateEditRequest(requestId, select.value);
      await refresh();
      if (activeClientId === clientId) $('#project-request-status').textContent = 'Request status updated in the client portal.';
    } catch (error) {
      if (activeClientId === clientId) $('#project-request-status').textContent = error.message;
    } finally {
      savingRequests.delete(requestId);
      if (activeClientId === clientId) renderProjectRequests(activeClient());
    }
  });
  $('#project-upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const client = activeClient(); if (!client || uploadingClients.has(client.id)) return;
    const files = [...$('#project-upload').files];
    const status = $('#project-upload-status');
    if (!files.length) return status.textContent = 'Choose at least one file to upload.';
    if (files.length > 5) return status.textContent = 'Choose no more than 5 files at a time.';
    if (files.some((file) => file.size > 10 * 1024 * 1024 || file.size === 0)) return status.textContent = 'Each file must be between 1 byte and 10 MB.';
    if (files.some((file) => !/\.(pdf|png|jpe?g|webp|txt|docx|zip)$/i.test(file.name))) return status.textContent = 'Use PDF, PNG, JPEG, WEBP, TXT, DOCX, or ZIP files.';
    uploadingClients.add(client.id);
    renderProject();
    let uploaded = 0;
    try {
      for (const file of files) {
        if (activeClientId === client.id) status.textContent = `Uploading ${uploaded + 1} of ${files.length}: ${file.name}`;
        await Portal.uploadProjectFile(client.id, file);
        uploaded += 1;
      }
      await refresh();
      if (activeClientId === client.id) {
        $('#project-upload').value = '';
        status.textContent = `${uploaded} file${uploaded === 1 ? '' : 's'} shared with the client.`;
      }
    } catch (error) {
      if (activeClientId === client.id) {
        status.textContent = `${uploaded ? `${uploaded} file(s) saved. ` : ''}${error.message}${uploaded ? ' Reselect only the remaining files to retry.' : ''}`;
        if (uploaded) $('#project-upload').value = '';
      }
      if (uploaded) await refresh().catch(() => {});
    } finally {
      uploadingClients.delete(client.id);
      if (activeClientId === client.id) renderProject();
    }
  });
  $('#project-view').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-project-file]');
    if (!button) return;
    const client = activeClient();
    const file = client?.files?.find((item) => item.id === button.dataset.projectFile);
    if (!file) return;
    button.disabled = true;
    const downloadWindow = window.open('about:blank', '_blank');
    if (downloadWindow) downloadWindow.opener = null;
    try {
      const url = new URL(await Portal.getProjectFileUrl(file));
      if (url.protocol !== 'https:') throw new Error('The file download link was not secure. Please try again.');
      if (downloadWindow) downloadWindow.location.href = url.href;
      else showToast('Allow pop-ups and open the file again.');
    } catch (error) { downloadWindow?.close(); showToast(error.message); }
    finally { button.disabled = false; }
  });
  window.addEventListener('beforeunload', (event) => {
    if (!projectDrafts.size) return;
    event.preventDefault();
    event.returnValue = '';
  });

  $('#message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const client = activeClient(); const input = $('#message-input'); const body = input.value.trim();
    if (!client || !client.email || !body) return;
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
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));
    const shouldInvite = $('#client-send-invite').checked;
    delete data.sendInvite;
    $('#client-create-status').textContent = 'Creating the private client workspace…';
    let created;
    try {
      created = await Portal.createClient(data);
    } catch (error) { $('#client-create-status').textContent = error.message; return; }
    finally { submitter.disabled = false; }
    form.reset(); dialog.close();
    $('#client-create-status').textContent = '';
    projectNotices.set(created.id, shouldInvite ? 'Sending the secure sign-in invitation…' : 'Client created. Copy the portal link or email an invitation when you are ready.');
    if (shouldInvite) invitingClients.add(created.id);
    try { await refresh(); openProject(created.id); }
    catch (_) { showToast('Client created. Reload the workspace to view it.'); }
    if (shouldInvite) {
      try {
        await Portal.sendMagicLink(data.email, portalUrl(created));
        projectNotices.set(created.id, `Invitation sent to ${data.email}. The client can sign in from their secure email link.`);
      } catch (error) {
        projectNotices.set(created.id, `Client created, but the invitation could not be sent: ${error.message} Copy the portal link above or retry the invitation. Do not create the client again.`);
      } finally { invitingClients.delete(created.id); }
    }
    if (activeClientId === created.id) renderProject();
    showToast('Client workspace created');
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
