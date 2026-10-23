(function () {
  const Portal = window.LaunchPointPortal;
  let state = Portal.read();
  let activeClientId = state.clients[0].id;
  let clientFilter = 'all';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value = '') => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const activeClient = () => state.clients.find((client) => client.id === activeClientId) || state.clients[0];

  const headings = {
    overview: ['Thursday, October 23', 'Good afternoon, Jacob.', 'Here’s what needs your attention across LaunchPoint.'],
    clients: ['Client roster', 'Every client, one clear view.', 'Track the work, the next decision, and the last conversation.'],
    messages: ['Client care', 'Keep the work moving.', 'Reply without losing the project context around the conversation.']
  };

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('is-visible');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  function setView(view) {
    $$('[data-view-panel]').forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
    $$('.nav-item').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
    });
    const [eyebrow, title, description] = headings[view];
    $('#view-eyebrow').textContent = eyebrow;
    $('#view-title').textContent = title;
    $('#view-description').textContent = description;
    if (view === 'messages') renderMessages();
    if (view === 'clients') renderClients();
    history.replaceState({}, '', view === 'overview' ? 'dashboard.html' : `dashboard.html?view=${view}`);
  }

  function renderMetrics() {
    const active = state.clients.filter((client) => client.status !== 'complete').length;
    const unread = state.clients.reduce((total, client) => total + (client.unread || 0), 0);
    $('#active-client-count').textContent = active;
    $('#open-project-count').textContent = state.clients.filter((client) => client.progress < 100).length;
    $('#unread-message-count').textContent = unread;
    $('#approval-count').textContent = state.clients.filter((client) => client.status === 'waiting').length;
    $('#nav-client-count').textContent = state.clients.length;
    $('#nav-unread-count').textContent = unread;
  }

  function renderAttention() {
    const clients = [...state.clients].sort((a, b) => (b.unread || 0) - (a.unread || 0)).slice(0, 4);
    $('#attention-list').innerHTML = clients.map((client, index) => `
      <button class="attention-row" type="button" data-open-client="${client.id}">
        <span class="attention-number">0${index + 1}</span>
        <span class="client-mark">${Portal.initials(client.business)}</span>
        <span class="attention-copy"><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(client.project)}</small></span>
        <span class="attention-task">${escapeHtml(client.nextStep)}</span>
        ${client.unread ? `<span class="unread-badge">${client.unread} new</span>` : `<span class="status-chip status-${client.status}">${client.status}</span>`}
        <span class="row-arrow" aria-hidden="true">→</span>
      </button>`).join('');
  }

  function renderClients() {
    const query = ($('#client-search').value || '').trim().toLowerCase();
    const clients = state.clients.filter((client) => {
      const matchesFilter = clientFilter === 'all' || client.status === clientFilter;
      const haystack = `${client.business} ${client.contact} ${client.project} ${client.nextStep}`.toLowerCase();
      return matchesFilter && haystack.includes(query);
    });
    $('#client-table-body').innerHTML = clients.map((client) => `
      <tr data-open-client="${client.id}">
        <td><span class="table-client"><span class="client-mark">${Portal.initials(client.business)}</span><span><strong>${escapeHtml(client.business)}</strong><small>${escapeHtml(client.contact)}</small></span></span></td>
        <td>${escapeHtml(client.project)}</td>
        <td><span class="status-chip status-${client.status}">${client.status}</span></td>
        <td>${escapeHtml(client.nextStep)}</td>
        <td>${escapeHtml(client.lastContact)}${client.unread ? `<span class="message-count">${client.unread}</span>` : ''}</td>
        <td><button class="table-open" type="button" aria-label="Open ${escapeHtml(client.business)}">→</button></td>
      </tr>`).join('');
    $('#clients-empty').hidden = clients.length > 0;
  }

  function renderThreadList() {
    const query = ($('#thread-search').value || '').trim().toLowerCase();
    const clients = state.clients.filter((client) => `${client.business} ${client.contact} ${client.project}`.toLowerCase().includes(query));
    $('#thread-list').innerHTML = clients.map((client) => {
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
    $('#conversation-client-mark').textContent = Portal.initials(client.business);
    $('#conversation-client-name').textContent = client.business;
    $('#conversation-project-name').textContent = client.project;
    $('#composer-client-name').textContent = client.business;
    $('#message-history').innerHTML = client.messages.map((message) => `
      <article class="message-bubble message-${message.sender}">
        <div><strong>${escapeHtml(message.sender === 'admin' ? 'You' : message.name)}</strong><time>${Portal.formatTime(message.createdAt)}</time></div>
        <p>${escapeHtml(message.body)}</p>
      </article>`).join('') || '<p class="conversation-empty">No messages yet. Send a short welcome note to begin.</p>';
    $('#message-history').scrollTop = $('#message-history').scrollHeight;
    $('#client-context').innerHTML = `
      <p class="section-kicker">Client context</p>
      <h3>${escapeHtml(client.business)}</h3>
      <dl>
        <div><dt>Contact</dt><dd>${escapeHtml(client.contact)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(client.email)}</dd></div>
        <div><dt>Project</dt><dd>${escapeHtml(client.project)}</dd></div>
        <div><dt>Value</dt><dd>${escapeHtml(client.value)}</dd></div>
        <div><dt>Target</dt><dd>${escapeHtml(client.targetDate)}</dd></div>
      </dl>
      <div class="context-progress"><span><b>Progress</b><em>${client.progress}%</em></span><div><i style="width:${client.progress}%"></i></div></div>
      <div class="context-next"><span>Next step</span><strong>${escapeHtml(client.nextStep)}</strong><p>${escapeHtml(client.nextCopy)}</p></div>`;
  }

  function openClient(id) {
    activeClientId = id;
    const client = activeClient();
    if (client.unread) {
      client.unread = 0;
      Portal.write(state);
      renderMetrics();
    }
    setView('messages');
  }

  function addMessage(sender, body) {
    const client = activeClient();
    client.messages.push({ id: crypto.randomUUID(), sender, name: sender === 'admin' ? 'Jacob' : client.contact.split(' ')[0], body, createdAt: new Date().toISOString() });
    client.lastContact = 'Just now';
    if (sender === 'client') client.unread = (client.unread || 0) + 1;
    Portal.write(state);
    renderMetrics();
    renderAttention();
    renderMessages();
  }

  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('[data-view-jump]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.viewJump)));
  $('#attention-list').addEventListener('click', (event) => { const row = event.target.closest('[data-open-client]'); if (row) openClient(row.dataset.openClient); });
  $('#client-table-body').addEventListener('click', (event) => { const row = event.target.closest('[data-open-client]'); if (row) openClient(row.dataset.openClient); });
  $('#thread-list').addEventListener('click', (event) => { const row = event.target.closest('[data-thread-id]'); if (row) { activeClientId = row.dataset.threadId; renderMessages(); } });
  $('#client-search').addEventListener('input', renderClients);
  $('#thread-search').addEventListener('input', renderThreadList);
  $$('.filter-button').forEach((button) => button.addEventListener('click', () => {
    clientFilter = button.dataset.clientFilter;
    $$('.filter-button').forEach((item) => item.classList.toggle('is-active', item === button));
    renderClients();
  }));
  $('#message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('#message-input');
    const body = input.value.trim();
    if (!body) return;
    addMessage('admin', body);
    input.value = '';
    $('#message-status').textContent = 'Saved to the client portal preview. No email was sent.';
    showToast('Message added to the portal preview');
  });
  $('#open-client-portal').addEventListener('click', () => window.open(`client.html?id=${encodeURIComponent(activeClientId)}`, '_blank', 'noopener'));
  $('#copy-portal-link').addEventListener('click', async () => {
    const link = new URL(`client.html?id=${encodeURIComponent(activeClientId)}`, location.href).href;
    try { await navigator.clipboard.writeText(link); showToast('Client portal link copied'); }
    catch (_) { showToast('Open the client portal to copy its address'); }
  });

  const dialog = $('#client-dialog');
  $('#new-client-button').addEventListener('click', () => dialog.showModal());
  $('#client-form').addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (!submitter || submitter.value !== 'save') return;
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const business = String(data.get('business')).trim();
    const id = `${business.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString().slice(-4)}`;
    state.clients.unshift({
      id, business, contact: String(data.get('contact')).trim(), email: String(data.get('email')).trim(), project: String(data.get('project')).trim(),
      status: String(data.get('status')), progress: 10, nextStep: String(data.get('nextStep')).trim(), nextCopy: 'Add a short note so your client knows exactly what to do next.',
      lastContact: 'Not contacted', unread: 0, targetDate: 'Set date', value: 'Scope pending', summary: 'Your LaunchPoint project is ready to begin.',
      milestones: [{ label: 'Kickoff', state: 'current' }, { label: 'Direction', state: 'upcoming' }, { label: 'Build', state: 'upcoming' }, { label: 'Launch', state: 'upcoming' }], messages: []
    });
    Portal.write(state);
    event.currentTarget.reset();
    dialog.close();
    renderMetrics(); renderAttention(); renderClients();
    showToast(`${business} added`);
  });

  const commandMenu = $('#command-menu');
  function toggleCommands(force) {
    commandMenu.hidden = typeof force === 'boolean' ? !force : !commandMenu.hidden;
    $('#command-button').setAttribute('aria-expanded', String(!commandMenu.hidden));
  }
  $('#command-button').addEventListener('click', () => toggleCommands());
  commandMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-command]'); if (!item) return;
    toggleCommands(false);
    if (item.dataset.command === 'new-client') dialog.showModal();
    if (item.dataset.command === 'messages') setView('messages');
    if (item.dataset.command === 'portal') window.open(`client.html?id=${encodeURIComponent(activeClientId)}`, '_blank', 'noopener');
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); toggleCommands(); }
    if (event.key === 'Escape' && !commandMenu.hidden) toggleCommands(false);
  });

  window.addEventListener('launchpoint:portal-update', (event) => { state = event.detail; renderMetrics(); renderAttention(); renderClients(); renderMessages(); });
  window.addEventListener('storage', () => { state = Portal.read(); renderMetrics(); renderAttention(); renderClients(); renderMessages(); });

  renderMetrics();
  renderAttention();
  renderClients();
  const initialView = new URLSearchParams(location.search).get('view');
  setView(['clients', 'messages'].includes(initialView) ? initialView : 'overview');
})();
