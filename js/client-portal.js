(function () {
  const Portal = window.LaunchPointPortal;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value = '') => String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const id = new URLSearchParams(location.search).get('id') || 'northline';
  let state = Portal.read();
  let client = state.clients.find((item) => item.id === id) || state.clients[0];

  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible');
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2800);
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
  }

  $('#portal-reply-form').addEventListener('submit', (event) => {
    event.preventDefault(); const input = $('#portal-reply-input'); const body = input.value.trim(); if (!body) return;
    client.messages.push({ id: crypto.randomUUID(), sender: 'client', name: client.contact.split(' ')[0], body, createdAt: new Date().toISOString() });
    client.unread = (client.unread || 0) + 1; client.lastContact = 'Just now';
    Portal.write(state); input.value = ''; render();
    $('#portal-reply-status').textContent = 'Reply saved to this portal preview.';
    showToast('Reply added to the studio preview');
  });

  $('#portal-review-button').addEventListener('click', () => {
    if (client.status === 'waiting') {
      client.status = 'active';
      client.messages.push({ id: crypto.randomUUID(), sender: 'client', name: client.contact.split(' ')[0], body: `Approved: ${client.nextStep}`, createdAt: new Date().toISOString() });
      client.unread = (client.unread || 0) + 1; Portal.write(state); render();
      showToast('Approval saved to the studio preview');
    } else {
      document.querySelector('#portal-reply-input').focus();
      showToast('Leave your review in a reply');
    }
  });

  window.addEventListener('storage', () => { state = Portal.read(); client = state.clients.find((item) => item.id === id) || state.clients[0]; render(); });
  render();
})();
