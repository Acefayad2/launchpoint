(function () {
  const config = window.LAUNCHPOINT_SUPABASE;
  if (!config || !window.supabase) throw new Error('LaunchPoint database configuration is missing.');

  const db = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const formatTime = (value) => value ? new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value)) : 'Not contacted';
  const initials = (value = '') => value.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function normalizeClient(row) {
    const messages = [...(row.messages || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const milestones = [...(row.milestones || [])].sort((a, b) => a.position - b.position);
    const approvals = [...(row.approvals || [])].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));
    return {
      id: row.id, slug: row.slug, business: row.business, contact: row.contact_name,
      email: row.contact_email, project: row.project, status: row.status, progress: row.progress,
      nextStep: row.next_step, nextCopy: row.next_copy, targetDate: row.target_date,
      value: row.project_value, summary: row.summary, lastContact: formatTime(row.last_contact_at),
      lastContactAt: row.last_contact_at,
      unread: messages.filter((message) => message.sender_role === 'client' && !message.read_by_admin_at).length,
      milestones: milestones.map((item) => ({ id: item.id, label: item.label, state: item.state, position: item.position })),
      approvals: approvals.map((item) => ({ id: item.id, label: item.label, status: item.status, requestedAt: item.requested_at, respondedAt: item.responded_at })),
      messages: messages.map((message) => ({ id: message.id, sender: message.sender_role, name: message.sender_name, body: message.body, createdAt: message.created_at }))
    };
  }

  async function getSession() {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    return data.session;
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
    return data.session;
  }

  async function signOut() {
    const { error } = await db.auth.signOut();
    if (error) throw error;
  }

  async function getRole() {
    const { data, error } = await db.rpc('current_user_role');
    if (error) throw error;
    return data;
  }

  async function loadClients() {
    const { data, error } = await db.from('clients').select('*, milestones(*), messages(*), approvals(*)').order('created_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(normalizeClient);
  }

  async function loadClient(identifier) {
    let query = db.from('clients').select('*, milestones(*), messages(*), approvals(*)');
    query = /^[0-9a-f-]{36}$/i.test(identifier || '') ? query.eq('id', identifier) : query.eq('slug', identifier);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? normalizeClient(data) : null;
  }

  async function createClient(input) {
    const slug = `${slugify(input.business) || 'client'}-${Date.now().toString().slice(-5)}`;
    const { data: client, error } = await db.from('clients').insert({
      slug, business: input.business.trim(), contact_name: input.contact.trim(),
      contact_email: input.email.trim().toLowerCase(), project: input.project.trim(),
      status: input.status, next_step: input.nextStep.trim()
    }).select().single();
    if (error) throw error;
    const milestones = ['Kickoff', 'Direction', 'Build', 'Launch'].map((label, position) => ({
      client_id: client.id, label, position, state: position === 0 ? 'current' : 'upcoming'
    }));
    const { error: milestoneError } = await db.from('milestones').insert(milestones);
    if (milestoneError) throw milestoneError;
    return client;
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
      .subscribe();
    return () => db.removeChannel(channel);
  }

  window.LaunchPointPortal = {
    db, getSession, sendMagicLink, signInWithPassword, signOut, getRole, loadClients, loadClient, createClient,
    addMessage, markMessagesRead, respondToApproval, subscribe,
    onAuthStateChange: (callback) => db.auth.onAuthStateChange(callback),
    formatTime, initials
  };
})();
