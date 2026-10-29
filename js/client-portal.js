(function () {
  const Portal = window.LaunchPointPortal;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value = '') => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const identifier = new URLSearchParams(location.search).get('id') || '';
  const requestLabels = { submitted: 'Submitted', in_progress: 'In progress', needs_info: 'Needs your input', completed: 'Completed' };
  const allowedFiles = { pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], webp: ['image/webp'], txt: ['text/plain'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], zip: ['application/zip', 'application/x-zip-compressed'] };
  let client = null, session = null, unsubscribeRealtime = null, refreshing = null;
  let pendingRequest = null, pendingProjectFiles = null, requestBusy = false, fileBusy = false, approvalBusy = false;
  let messageSignature = '', requestSignature = '', fileSignature = '', generation = 0;

  function status(selector, message, isError = false) {
    $(selector).textContent = message;
    $(selector).dataset.error = String(isError);
  }
  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('is-visible');
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 3500);
  }
  function clearSession() {
    generation += 1; session = null; client = null; unsubscribeRealtime?.(); unsubscribeRealtime = null;
    clearTimeout(initialize.realtimeTimer);
    pendingRequest = null; pendingProjectFiles = null;
    ['#portal-request-form', '#portal-file-form', '#portal-reply-form'].forEach((selector) => $(selector).reset());
    ['#portal-request-status', '#portal-file-status', '#portal-reply-status', '#portal-download-status', '#portal-approval-status', '#portal-sync-status'].forEach((selector) => status(selector, ''));
    ['#portal-message-history', '#portal-request-list', '#portal-file-list'].forEach((selector) => { $(selector).innerHTML = ''; });
    messageSignature = ''; requestSignature = ''; fileSignature = '';
    $('#portal-content').hidden = true;
    document.body.dataset.authState = 'signed-out';
  }
  function showAuth(message = '') { document.body.dataset.authState = 'signed-out'; status('#auth-status', message, Boolean(message)); }
  function safeUrl(value) {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function dateText(value) {
    if (!value || Number.isNaN(new Date(value).valueOf())) return '';
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
  }
  function sizeText(size) { return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((size || 0) / 1024))} KB`; }
  function fileMarkup(file) {
    const extension = String(file.filename || '').split('.').pop().slice(0, 5).toUpperCase();
    return `<button class="workspace-file" type="button" data-file-id="${escapeHtml(file.id)}" aria-label="Download ${escapeHtml(file.filename)}"><span aria-hidden="true">${escapeHtml(extension)}</span><span><strong>${escapeHtml(file.filename)}</strong><small>${sizeText(file.size)}${file.createdAt ? ` · ${escapeHtml(dateText(file.createdAt))}` : ''}</small></span><span aria-hidden="true">↓</span></button>`;
  }
  function validateFiles(list) {
    const files = Array.from(list || []);
    if (files.length > 5) throw new Error('Choose up to 5 files at a time.');
    files.forEach((file) => {
      const extension = file.name.split('.').pop().toLowerCase();
      if (file.name.length > 180) throw new Error('Shorten your filename to 180 characters or fewer.');
      if (!allowedFiles[extension] || (file.type && file.type !== 'application/octet-stream' && !allowedFiles[extension].includes(file.type))) throw new Error(`${file.name}: use PDF, PNG, JPG, WebP, TXT, DOCX or ZIP.`);
      if (!file.size) throw new Error(`${file.name} is empty. Choose a file with content.`);
      if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} is over the 10 MB limit.`);
    });
    return files;
  }
  function updateSubmissionControls() {
    const allowed = Boolean(client?.canSubmitEdits);
    $('#portal-request-fields').disabled = !allowed || requestBusy || Boolean(pendingRequest);
    $('#portal-request-submit').disabled = !allowed || requestBusy;
    $('#portal-request-submit').textContent = requestBusy ? 'Sending…' : pendingRequest ? 'Retry remaining attachments' : 'Send edit request ↗';
    $('#portal-request-submit').setAttribute('aria-busy', String(requestBusy));
    $('#portal-request-finish').hidden = !pendingRequest || requestBusy;
    $('#project-files').disabled = !allowed || fileBusy || Boolean(pendingProjectFiles);
    $('#portal-file-submit').disabled = !allowed || fileBusy;
    $('#portal-file-submit').textContent = fileBusy ? 'Uploading…' : pendingProjectFiles ? 'Retry remaining files' : 'Upload files';
    $('#portal-file-submit').setAttribute('aria-busy', String(fileBusy));
    $('#portal-file-finish').hidden = !pendingProjectFiles || fileBusy;
  }
  function render() {
    document.title = `${client.business} | LaunchPoint client workspace`;
    $('#portal-first-name').textContent = client.contact?.trim().split(/\s+/)[0] || client.business;
    $('#portal-project-summary').textContent = client.summary || 'Follow your project, share feedback, and keep everything in one place.';
    $('#portal-project-title').textContent = client.project || client.business;
    const stage = client.status === 'complete' ? 'Project delivered' : client.status === 'waiting' ? 'Ready for your review' : 'Building together';
    $('#portal-stage').textContent = `${client.business} / ${stage}`;
    $('#portal-status-chip').textContent = client.status === 'complete' ? 'Complete' : client.status === 'waiting' ? 'Your review' : 'In progress';
    $('#portal-status-chip').className = `status-chip status-${['active', 'waiting', 'complete'].includes(client.status) ? client.status : 'active'}`;
    const progress = Math.min(100, Math.max(0, Number(client.progress) || 0));
    $('#portal-progress-bar').style.width = `${progress}%`;
    $('#portal-progress-number').textContent = `${progress}%`;
    $('#portal-progress').setAttribute('aria-valuenow', String(progress));
    const milestones = client.milestones || [];
    $('#portal-progress-copy').textContent = milestones.length ? `${milestones.filter((item) => item.state === 'complete').length} of ${milestones.length} milestones complete` : 'Your milestones will appear here.';
    $('#portal-target-date').textContent = client.targetDate ? `Target: ${client.targetDate}` : 'Schedule being confirmed';
    $('#milestone-list').innerHTML = milestones.map((item) => `<li class="milestone-${['complete', 'current', 'upcoming'].includes(item.state) ? item.state : 'upcoming'}"><span aria-hidden="true"></span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.state)}</small></li>`).join('');
    $('#portal-next-title').textContent = client.nextStep || 'We’ll share your next step here.';
    $('#portal-next-copy').textContent = client.nextCopy || 'Questions in the meantime? Send your team a message below.';
    const approval = (client.approvals || []).find((item) => item.status === 'requested');
    const button = $('#portal-review-button');
    button.dataset.approvalId = approval?.id || ''; button.hidden = !approval;
    button.disabled = approvalBusy; button.textContent = approval ? `Approve ${approval.label}` : '';
    const careActive = client.supportStatus === 'active';
    const verificationUnavailable = Boolean(client.subscriptionError) || client.subscriptionStatus === 'verification_unavailable';
    $('#portal-care-status').textContent = verificationUnavailable ? 'Support check unavailable' : careActive ? 'Ongoing support active' : client.supportStatus === 'paused' ? 'Ongoing support paused' : client.supportStatus === 'canceled' ? 'Ongoing support ended' : 'Project workspace';
    $('#portal-care-plan').textContent = client.supportPlan || (careActive ? 'Your ongoing support' : 'Built around your project');
    $('#portal-care-copy').textContent = client.canSubmitEdits ? (careActive ? 'You can send new requests here while your ongoing support is active.' : 'Share edits and assets here while we build. Your team will update their status.') : 'New edits are closed. Your history and messages remain available. Message us about continuing support.';
    $('#portal-edit-access').textContent = client.canSubmitEdits ? 'One request per change keeps feedback clear. Add the page link and any reference files.' : 'New edit requests and uploads are currently closed. You can still message your team below.';
    if (verificationUnavailable && !client.canSubmitEdits) {
      $('#portal-care-copy').textContent = 'We couldn’t verify your subscription right now. New edits and uploads are temporarily unavailable. Your messages and project history remain open.';
      $('#portal-edit-access').textContent = 'We couldn’t verify your support subscription. New requests are temporarily unavailable; we’ll check again shortly. You can still message your team.';
    }
    const messages = client.messages || [];
    const nextMessages = JSON.stringify(messages);
    if (nextMessages !== messageSignature) {
      const history = $('#portal-message-history');
      const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 90;
      const firstRender = !messageSignature;
      history.innerHTML = messages.map((message) => `<article class="message-bubble message-${message.sender === 'admin' ? 'admin' : 'client'}"><div><strong>${message.sender === 'admin' ? 'LaunchPoint' : 'You'}</strong><time>${escapeHtml(Portal.formatTime(message.createdAt))}</time></div><p>${escapeHtml(message.body)}</p></article>`).join('') || '<p class="workspace-empty"><strong>Your direct line to the studio.</strong>Ask a question or share an update. Your conversation will stay here.</p>';
      if (firstRender || nearBottom) history.scrollTop = history.scrollHeight;
      messageSignature = nextMessages;
    }
    const requests = client.requests || [], files = client.files || [];
    $('#portal-request-count').textContent = `${requests.filter((item) => item.status !== 'completed').length} open`;
    const nextRequests = JSON.stringify([requests, files]);
    if (nextRequests !== requestSignature) {
      $('#portal-request-list').innerHTML = requests.map((request) => {
        const state = requestLabels[request.status] ? request.status : 'submitted'; const pageUrl = safeUrl(request.pageUrl);
        return `<article class="workspace-request"><header><span class="request-state request-state-${state}">${requestLabels[state]}</span><time>${escapeHtml(dateText(request.createdAt))}</time></header><h3>${escapeHtml(request.title)}</h3><p>${escapeHtml(request.description)}</p>${pageUrl ? `<a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pageUrl)} ↗</a>` : ''}<div>${files.filter((file) => file.requestId === request.id).map(fileMarkup).join('')}</div></article>`;
      }).join('') || '<p class="workspace-empty"><strong>A clear place for your feedback.</strong>Your requests and their progress will appear here once you send your first edit.</p>';
      requestSignature = nextRequests;
    }
    const nextFiles = JSON.stringify(files);
    if (nextFiles !== fileSignature) {
      $('#portal-file-list').innerHTML = files.map(fileMarkup).join('') || '<p class="workspace-empty">No files shared yet. Add the assets your team needs to get started.</p>';
      fileSignature = nextFiles;
    }
    updateSubmissionControls();
  }
  async function refresh() {
    if (refreshing) return refreshing;
    const currentGeneration = generation;
    refreshing = (async () => {
      const loaded = identifier ? await Portal.loadClient(identifier) : (await Portal.loadClients())[0] || null;
      if (currentGeneration !== generation) return;
      if (!loaded) throw new Error('This project is not shared with your signed-in email. Use the email address on your LaunchPoint invitation or contact your team.');
      client = loaded; render(); $('#portal-content').hidden = false; $('#portal-unavailable').hidden = true;
      status('#portal-sync-status', '');
      Portal.markMessagesRead(client.id).catch(() => {});
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function refreshQuietly() {
    if (!session || document.hidden) return;
    try { await refresh(); } catch { status('#portal-sync-status', 'Updates couldn’t refresh. Your draft is safe; we’ll try again shortly.', true); }
  }
  async function initialize() {
    const currentGeneration = generation;
    try {
      if (!Portal) throw new Error('The secure workspace could not load. Refresh the page to try again.');
      const currentSession = await Portal.getSession();
      if (currentGeneration !== generation) return;
      session = currentSession;
      if (!session) return showAuth();
      $('#account-email').textContent = session.user.email;
      await refresh();
      if (currentGeneration !== generation || !client) return;
      document.body.dataset.authState = 'ready';
      unsubscribeRealtime?.();
      unsubscribeRealtime = Portal.subscribe(client.id, () => {
        clearTimeout(initialize.realtimeTimer); initialize.realtimeTimer = setTimeout(refreshQuietly, 300);
      });
    } catch (error) {
      if (!session) return showAuth(error.message);
      document.body.dataset.authState = 'ready'; $('#portal-content').hidden = true; $('#portal-unavailable').hidden = false;
      $('#portal-unavailable-copy').textContent = error.message || 'We couldn’t load this project. Please try again.';
    }
  }
  $('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button');
    button.disabled = true; status('#auth-status', 'Sending your secure sign-in link…');
    try {
      if (!Portal) throw new Error('Refresh the page to reconnect to the secure workspace.');
      await Portal.sendMagicLink($('#auth-email').value.trim(), location.href);
      status('#auth-status', 'Check your email and open the secure link to continue.');
    } catch (error) { status('#auth-status', error.message, true); } finally { button.disabled = false; }
  });
  $('#retry-project').addEventListener('click', initialize);
  $('#sign-out-button').addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { await Portal.signOut(); clearSession(); showAuth(); } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  });
  $('#portal-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const input = $('#portal-reply-input'), body = input.value.trim(); if (!body || !client) return;
    const currentGeneration = generation;
    const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true;
    try {
      await Portal.addMessage(client.id, 'client', client.contact?.split(' ')[0] || client.business, body);
      if (currentGeneration !== generation) return;
      if (input.value.trim() === body) input.value = '';
      status('#portal-reply-status', 'Message sent to your LaunchPoint team.');
      await refreshQuietly();
    } catch (error) { if (currentGeneration === generation) status('#portal-reply-status', error.message, true); }
    finally { button.disabled = false; }
  });
  $('#portal-review-button').addEventListener('click', async (event) => {
    const button = event.currentTarget, approvalId = button.dataset.approvalId;
    if (!approvalId || approvalBusy) return; approvalBusy = true; button.disabled = true;
    try {
      await Portal.respondToApproval(approvalId, 'approved');
      button.hidden = true; status('#portal-approval-status', 'Approval sent to your team.');
      await refreshQuietly();
    } catch (error) { status('#portal-approval-status', error.message, true); }
    finally { approvalBusy = false; button.disabled = false; }
  });
  $('#portal-request-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!client?.canSubmitEdits || requestBusy) return;
    const currentGeneration = generation;
    requestBusy = true; updateSubmissionControls();
    try {
      if (!pendingRequest) {
        const title = $('#request-title').value.trim(), description = $('#request-description').value.trim(), pageUrl = $('#request-page-url').value.trim();
        if (!title || !description) throw new Error('Add a title and details for your request.');
        if (title.length > 120 || description.length > 5000 || pageUrl.length > 2048) throw new Error('Keep the title within 120 characters, details within 5,000, and page link within 2,048.');
        if (pageUrl && !safeUrl(pageUrl)) throw new Error('Use an https:// or http:// page link.');
        const files = validateFiles($('#request-files').files);
        status('#portal-request-status', 'Saving your request…');
        const request = await Portal.createEditRequest(client.id, { title, description, pageUrl });
        if (currentGeneration !== generation) return;
        pendingRequest = { id: request.id, files };
      }
      while (pendingRequest.files.length) {
        const file = pendingRequest.files[0]; status('#portal-request-status', `Request saved. Uploading ${file.name}…`);
        await Portal.uploadProjectFile(client.id, file, pendingRequest.id);
        if (currentGeneration !== generation) return;
        pendingRequest.files.shift();
      }
      pendingRequest = null; $('#portal-request-form').reset();
      status('#portal-request-status', 'Request sent. You can follow its progress here.');
      await refreshQuietly();
    } catch (error) {
      if (currentGeneration !== generation) return;
      status('#portal-request-status', pendingRequest ? `Your request is saved. ${pendingRequest.files.length} attachment(s) still need uploading. ${error.message} Use Retry to upload them without creating another request.` : error.message, true);
      if (pendingRequest) await refreshQuietly();
    } finally { requestBusy = false; updateSubmissionControls(); }
  });
  $('#portal-request-finish').addEventListener('click', () => {
    pendingRequest = null; $('#portal-request-form').reset();
    status('#portal-request-status', 'Your request is saved. Remaining attachments were not uploaded.'); updateSubmissionControls();
  });
  $('#portal-file-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!client?.canSubmitEdits || fileBusy) return;
    const currentGeneration = generation;
    fileBusy = true; updateSubmissionControls();
    try {
      pendingProjectFiles ||= validateFiles($('#project-files').files);
      if (!pendingProjectFiles.length) throw new Error('Choose at least one file to upload.');
      while (pendingProjectFiles.length) {
        const file = pendingProjectFiles[0]; status('#portal-file-status', `Uploading ${file.name}…`);
        await Portal.uploadProjectFile(client.id, file);
        if (currentGeneration !== generation) return;
        pendingProjectFiles.shift();
      }
      pendingProjectFiles = null; $('#portal-file-form').reset();
      status('#portal-file-status', 'Files shared with your LaunchPoint team.'); await refreshQuietly();
    } catch (error) { if (currentGeneration !== generation) return; if (!pendingProjectFiles?.length) pendingProjectFiles = null; status('#portal-file-status', `${error.message}${pendingProjectFiles ? ' Retry uploads only the remaining files.' : ''}`, true); await refreshQuietly(); }
    finally { fileBusy = false; updateSubmissionControls(); }
  });
  $('#portal-file-finish').addEventListener('click', () => {
    pendingProjectFiles = null; $('#portal-file-form').reset();
    status('#portal-file-status', 'Uploaded files are saved. Remaining files were not uploaded.'); updateSubmissionControls();
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-file-id]'); if (!button || !client) return;
    const currentGeneration = generation;
    const file = (client.files || []).find((item) => item.id === button.dataset.fileId); if (!file) return;
    button.disabled = true; status('#portal-download-status', 'Preparing secure download…');
    try {
      const url = safeUrl(await Portal.getProjectFileUrl(file));
      if (currentGeneration !== generation) return;
      if (!url) throw new Error('The file download could not be opened.');
      const link = document.createElement('a'); link.href = url; link.download = file.filename; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = `Open ${file.filename}`;
      $('#portal-download-status').replaceChildren(document.createTextNode('Your secure file is ready: '), link);
      link.click();
    } catch (error) { status('#portal-download-status', error.message, true); showToast(error.message); }
    finally { button.disabled = false; }
  });
  window.addEventListener('focus', refreshQuietly);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuietly(); });
  setInterval(refreshQuietly, 30000);
  Portal?.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { clearSession(); showAuth(); } else if (event === 'SIGNED_IN' && !session) initialize(); });
  initialize();
})();
