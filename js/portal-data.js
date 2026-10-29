(function () {
  const config = window.LAUNCHPOINT_SUPABASE;
  if (!config || !window.supabase) throw new Error('LaunchPoint database configuration is missing.');

  // Match Supabase's existing default key so current sessions remain compatible.
  const authStorageKey = `sb-${new URL(config.url).hostname.split('.')[0]}-auth-token`;
  const authStorageKeys = [authStorageKey, `${authStorageKey}-code-verifier`, `${authStorageKey}-user`];
  const memoryAuthStorage = new Map();
  const authListeners = new Set();
  let localSignOutBlocked = false;
  const authStorage = {
    getItem(key) {
      if (localSignOutBlocked) return null;
      try {
        if (window.localStorage) {
          const stored = window.localStorage.getItem(key);
          if (stored !== null) return stored;
        }
      } catch (_) { /* Private browsing can disable storage. */ }
      return memoryAuthStorage.get(key) ?? null;
    },
    setItem(key, value) {
      // A refresh already in flight when logout begins must not restore its session.
      if (localSignOutBlocked) return;
      try { if (window.localStorage) { window.localStorage.setItem(key, value); memoryAuthStorage.delete(key); return; } } catch (_) { /* Keep non-persisted auth in memory only. */ }
      memoryAuthStorage.set(key, value);
    },
    removeItem(key) {
      memoryAuthStorage.delete(key);
      if (window.localStorage) window.localStorage.removeItem(key);
    }
  };
  const db = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: authStorageKey, storage: authStorage }
  });
  const formatTime = (value) => value ? new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value)) : 'Not contacted';
  const initials = (value = '') => value.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const projectSelect = '*, milestones(*), messages(*), approvals(*), edit_requests(*), project_files(*)';
  const fileTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: 'application/zip' };
  const normalizeFile = row => ({ id: row.id, requestId: row.request_id, filename: row.filename, mimeType: row.mime_type, size: row.size, createdAt: row.created_at, uploadedBy: row.uploaded_by });
  const normalizeRequest = row => ({ id: row.id, title: row.title, description: row.description, pageUrl: row.page_url, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });

  function normalizeClient(row) {
    const messages = [...(row.messages || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const milestones = [...(row.milestones || [])].sort((a, b) => a.position - b.position);
    const approvals = [...(row.approvals || [])].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));
    return {
      id: row.id, slug: row.slug, business: row.business, contact: row.contact_name || '',
      email: row.contact_email || '', project: row.project, status: row.status, progress: row.progress,
      nextStep: row.next_step, nextCopy: row.next_copy, targetDate: row.target_date,
      value: row.project_value, summary: row.summary, lastContact: formatTime(row.last_contact_at),
      lastContactAt: row.last_contact_at,
      supportStatus: row.support_status || 'none', supportPlan: row.support_plan || '',
      stripeSubscriptionId: row.stripe_subscription_id || '', subscriptionStatus: row.subscription_status || 'unlinked',
      subscriptionCheckedAt: row.subscription_checked_at, subscriptionAccessUntil: row.subscription_access_until,
      subscriptionError: row.subscription_error || '',
      canSubmitEdits: ['active', 'waiting'].includes(row.status) || (row.support_status === 'active'
        && new Date(row.subscription_checked_at).getTime() > Date.now() - 600000
        && new Date(row.subscription_access_until).getTime() > Date.now()),
      requests: [...(row.edit_requests || [])].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).map(normalizeRequest),
      files: [...(row.project_files || [])].sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).map(normalizeFile),
      unread: messages.filter((message) => message.sender_role === 'client' && !message.read_by_admin_at).length,
      milestones: milestones.map((item) => ({ id: item.id, label: item.label, state: item.state, position: item.position })),
      approvals: approvals.map((item) => ({ id: item.id, label: item.label, status: item.status, requestedAt: item.requested_at, respondedAt: item.responded_at })),
      messages: messages.map((message) => ({ id: message.id, sender: message.sender_role, name: message.sender_name, body: message.body, createdAt: message.created_at }))
    };
  }

  async function getSession() {
    if (localSignOutBlocked) return null;
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    if (localSignOutBlocked) return null;
    return data.session;
  }

  async function acceptSignInSession(session) {
    // Called only after an explicit password sign-in or sign-up succeeds, never
    // from INITIAL_SESSION, TOKEN_REFRESHED, or a generic SDK auth event.
    if (!session?.access_token || !session.user?.id) return;
    const wasBlocked = localSignOutBlocked;
    localSignOutBlocked = false;
    if (wasBlocked) {
      authStorage.setItem(authStorageKey, JSON.stringify(session));
      await db.auth.startAutoRefresh?.();
    }
  }

  async function sendMagicLink(email, redirectTo) {
    const { error } = await db.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true }
    });
    if (error) throw error;
  }

  async function signInWithPassword(email, password) {
    const { data, error } = await db.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password
    });
    if (error) throw error;
    await acceptSignInSession(data.session);
    return data.session;
  }

  async function signOut() {
    const { error } = await db.auth.signOut();
    if (error) throw error;
  }

  async function adminAccess(action, payload = {}) {
    const session = await getSession();
    if (action !== 'invite-info' && !session) throw new Error('Please sign in again.');
    const response = await fetch('/api/admin-access', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}) },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Admin verification is temporarily unavailable. Please try again.');
      error.status = response.status;
      error.retryAfter = Number(data.retryAfter || response.headers?.get('Retry-After')) || 0;
      throw error;
    }
    return data;
  }

  async function signOutAdmin() {
    // Revoke the phone-verification lease before invalidating the first-factor session.
    // Even when the network is unavailable, clear the local session and lock the UI.
    let revokeError;
    try { await adminAccess('revoke'); } catch (error) { revokeError = error; }
    let signOutError;
    try { await signOut(); } catch (error) { signOutError = error; }
    // Supabase can return a network error before clearing persisted credentials.
    // Always lock locally and remove only this app's known auth storage entries.
    localSignOutBlocked = true;
    try { await db.auth.stopAutoRefresh?.(); } catch (_) { /* The storage guard still blocks late writes. */ }
    let storageError = false;
    for (const key of authStorageKeys) {
      try { authStorage.removeItem(key); } catch (_) { storageError = true; }
    }
    authListeners.forEach(callback => callback('SIGNED_OUT', null));
    if (storageError) throw new Error('This tab is locked, but browser storage could not be cleared. Close this browser and clear LaunchPoint site data before using a shared device.');
    if (signOutError) throw new Error('Signed out on this browser. The server could not be reached; any existing server session will expire automatically.');
    if (revokeError) throw new Error('Signed out. Verification could not be revoked online; it will expire automatically.');
  }

  function onAuthStateChange(callback) {
    authListeners.add(callback);
    const result = db.auth.onAuthStateChange((event, session) => {
      if (localSignOutBlocked && event !== 'SIGNED_OUT') return;
      callback(event, session);
    });
    const subscription = result.data.subscription;
    const unsubscribe = subscription.unsubscribe.bind(subscription);
    subscription.unsubscribe = () => { authListeners.delete(callback); unsubscribe(); };
    return result;
  }
  window.addEventListener?.('storage', event => {
    if (event.key !== authStorageKey || event.newValue !== null) return;
    localSignOutBlocked = true;
    Promise.resolve(db.auth.stopAutoRefresh?.()).catch(() => {});
    authListeners.forEach(callback => callback('SIGNED_OUT', null));
  });

  async function getRole() {
    const { data, error } = await db.rpc('current_user_role');
    if (error) throw error;
    return data;
  }

  async function paymentRequest(method, payload) {
    const session = await getSession();
    if (!session) throw new Error('Please sign in again.');
    const response = await fetch('/api/payment-links', {
      method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {})
      },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'The payment service is unavailable.');
      error.paymentResult = data;
      throw error;
    }
    return data;
  }

  const getPaymentIntegrationStatus = () => paymentRequest('GET');
  const createPaymentLink = (input) => paymentRequest('POST', input);

  async function loadClients() {
    const { data, error } = await db.from('clients').select(projectSelect).order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(normalizeClient);
  }

  async function loadClient(identifier) {
    let query = db.from('clients').select(projectSelect);
    query = /^[0-9a-f-]{36}$/i.test(identifier || '') ? query.eq('id', identifier) : query.eq('slug', identifier);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.stripe_subscription_id && !['active','waiting'].includes(data.status)
      && (!data.subscription_checked_at || new Date(data.subscription_checked_at).getTime() < Date.now() - 300000)) {
      try {
        const result = await syncSubscription(data.id);
        Object.assign(data, { support_status: result.supportStatus, subscription_status: result.subscriptionStatus,
          subscription_checked_at: result.checkedAt, subscription_access_until: result.accessUntil });
      } catch {
        data.support_status = 'paused';
        data.subscription_status = 'verification_unavailable';
        data.subscription_error = 'We could not verify your subscription right now. Please try again shortly or message LaunchPoint.';
      }
    }
    return normalizeClient(data);
  }

  async function createClient(input) {
    const { data, error } = await db.rpc('create_project_workspace', { p_project: input });
    if (error) throw error;
    return data;
  }

  async function updateProject(clientId, input) {
    const { milestones, ...project } = input;
    const { data, error } = await db.rpc('save_project_workspace', { p_client_id: clientId, p_project: project, p_milestones: milestones });
    if (error) throw error;
    return data;
  }

  async function syncSubscription(clientId) {
    const session = await getSession();
    if (!session) throw new Error('Please sign in again.');
    const response = await fetch('/api/project-subscription', {
      method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Subscription verification is temporarily unavailable.');
    return result;
  }

  async function checkEditAccess(clientId) {
    if (await getRole() === 'admin') return;
    const client = await loadClient(clientId);
    if (!client?.canSubmitEdits) throw new Error('New edits and uploads are available during your build or with an active, paid support subscription. You can still message LaunchPoint.');
  }

  async function createEditRequest(clientId, input) {
    await checkEditAccess(clientId);
    const session = await getSession();
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    const pageUrl = String(input.pageUrl || '').trim();
    if (!title || title.length > 120 || !description || description.length > 5000) throw new Error('Add a title and describe the changes you need.');
    if (pageUrl) {
      try { if (pageUrl.length > 2048 || /\s/.test(pageUrl) || !['https:','http:'].includes(new URL(pageUrl).protocol)) throw new Error(); }
      catch { throw new Error('Use a full website URL beginning with https:// or http://.'); }
    }
    const { data, error } = await db.from('edit_requests').insert({ client_id: clientId, created_by: session.user.id,
      title, description, page_url: pageUrl }).select().single();
    if (error) throw error;
    return normalizeRequest(data);
  }

  async function updateEditRequest(id, status) {
    if (!['submitted','in_progress','needs_info','completed'].includes(status)) throw new Error('Choose a valid request status.');
    const { data, error } = await db.from('edit_requests').update({ status }).eq('id', id).select('id').single();
    if (error) throw error;
    return data;
  }

  async function uploadProjectFile(clientId, file, requestId = null) {
    const extension = String(file?.name || '').split('.').pop().toLowerCase();
    const contentType = fileTypes[extension];
    if (!contentType || file.size <= 0 || file.size > 10485760 || file.name.length > 180) throw new Error('Choose a PDF, PNG, JPG, WEBP, TXT, DOCX, or ZIP file up to 10 MB with a short filename.');
    const suppliedType = String(file.type || '').toLowerCase();
    const zipVariant = extension === 'zip' && ['application/x-zip-compressed','application/x-zip'].includes(suppliedType);
    if (suppliedType && suppliedType !== contentType && !zipVariant) throw new Error('The file type does not match its filename. Please choose the original file.');
    await checkEditAccess(clientId);
    const session = await getSession();
    if (!session) throw new Error('Please sign in again.');
    const path = `${clientId}/${session.user.id}/${crypto.randomUUID()}.${extension}`;
    const bucket = db.storage.from('project-files');
    const { error: uploadError } = await bucket.upload(path, file, { contentType, upsert: false });
    if (uploadError) throw uploadError;
    const { data, error } = await db.from('project_files').insert({ client_id: clientId, request_id: requestId,
      uploaded_by: session.user.id, storage_path: path, filename: file.name, mime_type: contentType, size: file.size }).select().single();
    if (error) {
      await bucket.remove([path]).catch(() => {});
      throw new Error('The file could not be attached. Please try uploading it again.');
    }
    return normalizeFile(data);
  }

  async function getProjectFileUrl(file) {
    const { data, error } = await db.from('project_files').select('storage_path,filename').eq('id', file.id).single();
    if (error) throw error;
    const result = await db.storage.from('project-files').createSignedUrl(data.storage_path, 60, { download: data.filename });
    if (result.error) throw result.error;
    return result.data.signedUrl;
  }

  async function addMessage(clientId, senderRole, senderName, body) {
    const session = await getSession();
    if (!session) throw new Error('Please sign in again.');
    const { error } = await db.from('messages').insert({
      client_id: clientId, sender_id: session.user.id, sender_role: senderRole,
      sender_name: senderName, body: body.trim()
    });
    if (error) throw error;
    if (senderRole === 'admin') {
      const { error: updateError } = await db.from('clients').update({ last_contact_at: new Date().toISOString() }).eq('id', clientId);
      if (updateError) throw updateError;
    }
  }

  async function markMessagesRead(clientId) {
    const { error } = await db.rpc('mark_messages_read', { p_client_id: clientId });
    if (error) throw error;
  }

  async function respondToApproval(approvalId, status) {
    const { error } = await db.rpc('respond_to_approval', { p_approval_id: approvalId, p_status: status });
    if (error) throw error;
  }

  function subscribe(clientId, callback) {
    const filter = clientId ? `client_id=eq.${clientId}` : undefined;
    const channel = db.channel(`portal-${clientId || 'admin'}-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', ...(filter ? { filter } : {}) }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'approvals', ...(filter ? { filter } : {}) }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clients', ...(clientId ? { filter: `id=eq.${clientId}` } : {}) }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'milestones', ...(filter ? { filter } : {}) }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'edit_requests', ...(filter ? { filter } : {}) }, callback)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_files', ...(filter ? { filter } : {}) }, callback)
      .subscribe();
    return () => db.removeChannel(channel);
  }

  window.LaunchPointPortal = {
    db, getSession, sendMagicLink, signInWithPassword, acceptSignInSession, signOut, signOutAdmin, adminAccess, getRole, loadClients, loadClient, createClient,
    addMessage, markMessagesRead, respondToApproval, subscribe, getPaymentIntegrationStatus, createPaymentLink,
    updateProject, syncSubscription, createEditRequest, updateEditRequest, uploadProjectFile, getProjectFileUrl,
    onAuthStateChange,
    formatTime, initials
  };
})();
