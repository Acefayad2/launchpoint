(function () {
  const Portal = window.LaunchPointPortal;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value = '') => String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[char]));
  const identifier = new URLSearchParams(location.search).get('id') || '';
  let client = null;
  let session = null;
  let unsubscribeRealtime = null;

  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible');
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
  }

  function showAuth(message = '') {
    document.body.dataset.authState = 'signed-out';
    $('#auth-status').textContent = message;
  }

  function render() {
    document.title = `${client.business} | LaunchPoint client portal`;
    $('#portal-first-name').textContent = client.contact.split(' ')[0];
    $('#portal-project-summary').textContent = client.summary;
    $('#portal-project-title').textContent = client.project;
    $('#portal-stage').textContent = client.status === 'complete' ? 'Project live' : client.status === 'waiting' ? 'Ready for your review' : 'Project in progress';
    $('#portal-status-chip').textContent = client.status === 'complete' ? 'Live' : client.status === 'waiting' ? 'Your review' : 'In progress';
    $('#portal-status-chip').className = `status-chip status-${client.status}`;
    $('#portal-progress-bar').style.width = `${client.progress}%`;
    const complete = client.milestones.filter((item) => item.state === 'complete').length;
    $('#portal-progress-copy').textContent = `${complete} of ${client.milestones.length} milestones complete`;
    $('#portal-target-date').textContent = `Target: ${client.targetDate}`;
    $('#milestone-list').innerHTML = client.milestones.map((item) => `<li class="milestone-${item.state}"><span></span><strong>${escapeHtml(item.label)}</strong><small>${item.state}</small></li>`).join('');
    $('#portal-next-title').textContent = client.nextStep;
    $('#portal-next-copy').textContent = client.nextCopy;
    $('#portal-message-history').innerHTML = client.messages.map((message) => `<article class="message-bubble message-${message.sender}"><div><strong>${escapeHtml(message.sender === 'admin' ? 'LaunchPoint' : 'You')}</strong><time>${Portal.formatTime(message.createdAt)}</time></div><p>${escapeHtml(message.body)}</p></article>`).join('') || '<p class="conversation-empty">Your project conversation will appear here.</p>';
    $('#portal-message-history').scrollTop = $('#portal-message-history').scrollHeight;

    const approval = client.approvals.find((item) => item.status === 'requested');
    const button = $('#portal-review-button');
    button.dataset.approvalId = approval?.id || '';
    button.disabled = !approval;
    button.textContent = approval ? `Approve ${approval.label}` : 'No approval requested';
  }

  async function refresh() {
    client = identifier ? await Portal.loadClient(identifier) : (await Portal.loadClients())[0] || null;
    if (!client) throw new Error('This portal is not available for the signed-in email.');
    render();
    await Portal.markMessagesRead(client.id);
  }

  async function initialize() {
    try {
      session = await Portal.getSession();
      if (!session) return showAuth();
      await refresh();
      document.body.dataset.authState = 'ready';
      $('#account-email').textContent = session.user.email;
      unsubscribeRealtime?.();
      unsubscribeRealtime = Portal.subscribe(client.id, () => {
        clearTimeout(initialize.realtimeTimer);
        initialize.realtimeTimer = setTimeout(() => refresh().catch(console.error), 250);
      });
    } catch (error) {
      console.error(error);
      showAuth(error.message);
    }
  }

  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = $('#auth-email').value.trim();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true; $('#auth-status').textContent = 'Sending your secure sign-in link…';
    try {
      await Portal.sendMagicLink(email, location.href);
      $('#auth-status').textContent = 'Check your email and open the secure link to continue.';
    } catch (error) { $('#auth-status').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('#sign-out-button').addEventListener('click', async () => { await Portal.signOut(); location.reload(); });
  $('#portal-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#portal-reply-input'); const body = input.value.trim(); if (!body || !client) return;
    const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
    try {
      await Portal.addMessage(client.id, 'client', client.contact.split(' ')[0], body);
      input.value = ''; $('#portal-reply-status').textContent = 'Delivered securely to LaunchPoint.';
      await refresh(); showToast('Reply delivered');
    } catch (error) { $('#portal-reply-status').textContent = error.message; }
    finally { button.disabled = false; }
  });

  $('#portal-review-button').addEventListener('click', async (event) => {
    const approvalId = event.currentTarget.dataset.approvalId;
    if (!approvalId) return;
    event.currentTarget.disabled = true;
    try {
      await Portal.respondToApproval(approvalId, 'approved');
      await Portal.addMessage(client.id, 'client', client.contact.split(' ')[0], `Approved: ${event.currentTarget.textContent.replace(/^Approve\s+/, '')}`);
      await refresh(); showToast('Approval sent to LaunchPoint');
    } catch (error) { showToast(error.message); event.currentTarget.disabled = false; }
  });

  Portal.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showAuth(); });
  initialize();
})();
