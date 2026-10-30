(function () {
  const Portal = window.LaunchPointPortal;
  const $ = (selector) => document.querySelector(selector);
  const inviteStorageKey = 'launchpoint-admin-invite';
  let inviteToken = '';
  let invite = null;
  let session = null;
  let access = null;
  let mode = 'signin';
  let modeInitialized = false;
  let pendingEmail = '';
  let emailResendAt = 0;
  const pendingEmailKey = 'launchpoint-admin-pending-email';
  let challengeId = '';
  let resendAt = 0;
  let resendTimer;
  let expiryTimer;
  let refreshInFlight = false;
  let operationInFlight = false;
  let epoch = 0;
  const redirectTo = new URL('admin-setup.html', location.href).href.split('#')[0].split('?')[0];

  // The auth client is already initialized. Remove ONLY the invitation fragment;
  // leave Supabase's access_token/error parameters available to its URL handler.
  const fragment = new URLSearchParams(location.hash.slice(1));
  const incomingInvite = fragment.get('invite');
  if (incomingInvite) {
    try { if (sessionStorage.getItem(inviteStorageKey) !== incomingInvite) sessionStorage.removeItem(pendingEmailKey); } catch (_) { /* Storage is optional. */ }
    inviteToken = incomingInvite;
    try { sessionStorage.setItem(inviteStorageKey, inviteToken); } catch (_) { /* Keep this tab open if storage is unavailable. */ }
    fragment.delete('invite');
    history.replaceState(null, '', `${location.pathname}${location.search}${fragment.size ? `#${fragment.toString()}` : ''}`);
  } else {
    try { inviteToken = sessionStorage.getItem(inviteStorageKey) || ''; } catch (_) { /* Setup can resume from the original SMS link. */ }
  }
  try { if (inviteToken) pendingEmail = sessionStorage.getItem(pendingEmailKey) || ''; } catch (_) { /* Storage is optional. */ }

  function notice(message = '') { $('#setup-status').textContent = message; }
  function hideSections() {
    for (const id of ['setup-auth', 'setup-email-pending', 'setup-verify', 'setup-security', 'setup-invite', 'setup-dashboard-link']) $(`#${id}`).hidden = true;
  }
  function clearSecrets() {
    for (const id of ['setup-password', 'setup-password-confirm', 'setup-code', 'security-password', 'security-password-confirm', 'security-nonce']) $(`#${id}`).value = '';
  }
  function clearInvite() {
    inviteToken = ''; invite = null;
    pendingEmail = ''; modeInitialized = false;
    try { sessionStorage.removeItem(pendingEmailKey); } catch (_) { /* Storage is optional. */ }
    try { sessionStorage.removeItem(inviteStorageKey); } catch (_) { /* Already held in memory only. */ }
  }
  function setMode(next) {
    modeInitialized = true;
    mode = next;
    const create = mode === 'signup';
    $('#setup-auth-title').textContent = create ? 'Create your account.' : 'Sign in to your account.';
    $('#setup-auth-copy').textContent = create ? 'Choose your own email and a strong password. We’ll email you a confirmation link before verifying your phone.' : invite?.existingAccount ? 'Use your existing LaunchPoint email and password first. After verifying your phone, you can safely change them.' : 'Sign in to continue, then verify the phone on your setup invitation.';
    $('#setup-auth-submit').textContent = create ? 'Create account' : 'Sign in';
    $('#setup-confirm-wrap').hidden = !create;
    $('#setup-password-confirm').required = create;
    $('#setup-password').minLength = create ? 12 : 1;
    $('#setup-password').autocomplete = create ? 'new-password' : 'current-password';
    $('#setup-password-hint').hidden = !create;
    $('#setup-toggle-auth').hidden = !invite || invite.existingAccount;
    $('#setup-toggle-auth').textContent = create ? 'Already have an account? Sign in' : 'Need a new account? Create one';
    $('#setup-magic-link').hidden = create;
    clearSecrets();
  }
  function showEmailPending(email) {
    pendingEmail = email;
    try { sessionStorage.setItem(pendingEmailKey, email); } catch (_) { /* Keep this tab open. */ }
    hideSections();
    $('#setup-email-pending').hidden = false;
    $('#setup-email-pending-copy').textContent = `Check ${email} and confirm your address before signing in. If you already registered this email, use your existing password after confirmation.`;
    clearSecrets();
  }
  function showSecurity(status) {
    hideSections();
    $('#setup-title').textContent = 'You’re in control.';
    $('#setup-description').textContent = 'Manage your sign-in and the people who help run LaunchPoint.';
    $('#setup-dashboard-link').hidden = false;
    $('#setup-invite').hidden = false;
    const phoneVerified = status.requiresVerification === true && status.verified;
    $('#setup-security').hidden = !phoneVerified;
    $('#setup-legacy-note').hidden = phoneVerified;
    $('#security-current-email').textContent = `Signed in as ${session.user.email}`;
  }
  function scheduleExpiry(status) {
    clearTimeout(expiryTimer);
    if (status.requiresVerification !== true || !status.verified) return;
    const expiresAt = Date.parse(status.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Your phone verification has expired. Request a new code.');
    expiryTimer = setTimeout(() => {
      epoch += 1; access = null; hideSections(); clearSecrets();
      refresh().then(() => notice('Your verification expired. Verify your phone again to continue.'));
    }, Math.min(expiresAt - Date.now(), 2147483647));
  }

  async function refresh() {
    if (refreshInFlight || operationInFlight) return;
    refreshInFlight = true;
    const revision = epoch;
    let recoveryNotice = '';
    try {
      session = await Portal.getSession();
      if (revision !== epoch) return;
      $('#setup-signout').hidden = !session;
      $('#setup-signout').textContent = 'Sign out / use another account';
      access = session ? await Portal.adminAccess('status') : null;
      if (revision !== epoch) return;
      if (access?.isAdmin && access.verified && !inviteToken) {
        scheduleExpiry(access); showSecurity(access); notice(); return;
      }
      {
        const hadInvitation = Boolean(inviteToken || invite);
        // The HttpOnly cookie survives email confirmation opening a fresh tab.
        try { invite = await Portal.adminAccess('invite-info', inviteToken ? { inviteToken } : {}); }
        catch (error) {
          if (error.status !== 404) throw error;
          if (access?.isAdmin && access.verified && access.requiresVerification === true) {
            clearInvite(); scheduleExpiry(access); showSecurity(access); notice(); return;
          }
          clearInvite();
          if (hadInvitation) recoveryNotice = 'That setup link has expired or was canceled. Sign in below, or ask a LaunchPoint administrator to text you a fresh invitation.';
          if (access?.isAdmin && access.verified) { scheduleExpiry(access); showSecurity(access); notice(recoveryNotice); return; }
        }
        if (revision !== epoch) return;
        if (invite) {
          $('#setup-title').textContent = `Welcome${invite.name ? `, ${invite.name}` : ''}.`;
          $('#setup-description').textContent = 'Set up your personal LaunchPoint admin sign-in. This invitation gives you full access after email and phone verification.';
        }
      }
      hideSections();
      if (session && access?.isAdmin && invite && !invite.existingAccount) {
        $('#setup-signout').textContent = 'Sign out to create your new account';
        notice(`You are already signed in as ${session.user.email}. This invitation is for a new account. Sign out below, then choose a different email and your new password. Your existing admin account will not be deleted.`);
        return;
      }
      if (!session) {
        if (pendingEmail && invite) { showEmailPending(pendingEmail); notice('Email confirmation is next. Your setup invitation is still saved in this tab.'); return; }
        $('#setup-auth').hidden = false;
        if (!modeInitialized) setMode(invite && !invite.existingAccount ? 'signup' : 'signin');
        notice(recoveryNotice || (invite ? '' : 'Sign in to manage your account. New administrators need the private setup link sent to their phone.'));
        return;
      }
      if (!invite && !access?.isAdmin) {
        notice(recoveryNotice || 'This account does not have admin access. Reopen your original setup text in this browser, or ask an administrator for a new invitation.');
        return;
      }
      $('#setup-verify').hidden = false;
      pendingEmail = '';
      try { sessionStorage.removeItem(pendingEmailKey); } catch (_) { /* Storage is optional. */ }
      $('#setup-session-email').textContent = `Signed in as ${session.user.email}`;
      $('#setup-phone-label').textContent = `We’ll send a one-use code to ${invite?.phoneMasked || access?.phoneMasked || 'your registered phone'}.`;
      notice('Verify the invited phone to finish securing your admin account.');
    } catch (error) {
      hideSections(); clearSecrets(); notice(error.message);
    } finally { refreshInFlight = false; }
  }

  $('#setup-toggle-auth').addEventListener('click', () => { setMode(mode === 'signup' ? 'signin' : 'signup'); notice(); });
  $('#setup-auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (operationInFlight) return;
    const email = $('#setup-email').value.trim().toLowerCase();
    const password = $('#setup-password').value;
    if (mode === 'signup' && (password.length < 12 || password !== $('#setup-password-confirm').value)) return notice('Use a password of at least 12 characters, and make sure both passwords match.');
    const button = $('#setup-auth-submit'); button.disabled = true; operationInFlight = true;
    notice(mode === 'signup' ? 'Creating your account securely…' : 'Signing in securely…');
    let ready = false;
    try {
      if (mode === 'signup') {
        if (!invite || invite.existingAccount) throw new Error('A valid new-admin invitation is required to create an account here.');
        const { data, error } = await Portal.db.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        ready = Boolean(data.session);
        if (ready) await Portal.acceptSignInSession(data.session);
        if (!ready) {
          emailResendAt = Date.now() + 60_000;
          showEmailPending(email);
          notice('Check your email and confirm your address. Your invitation is saved in this tab; phone verification is still required.');
        }
      } else {
        await Portal.signInWithPassword(email, password); ready = true;
      }
    } catch (error) {
      if (error.code === 'email_not_confirmed') { showEmailPending(email); notice('Confirm your email before signing in. You can resend the confirmation below.'); }
      else if (error.code === 'invalid_credentials') notice('That email and password did not sign in. For a new account, choose “Need a new account? Create one.” Creating an account does not change the password of an existing account.');
      else notice(error.message);
    }
    finally { clearSecrets(); button.disabled = false; operationInFlight = false; }
    if (ready) await refresh();
  });
  $('#setup-email-continue').addEventListener('click', async () => {
    const email = pendingEmail;
    pendingEmail = '';
    try { sessionStorage.removeItem(pendingEmailKey); } catch (_) { /* Storage is optional. */ }
    setMode('signin');
    $('#setup-email').value = email;
    await refresh();
    if (!session) notice('Sign in with the email and password you just created, then verify your invited phone.');
  });
  $('#setup-email-change').addEventListener('click', async () => {
    pendingEmail = '';
    try { sessionStorage.removeItem(pendingEmailKey); } catch (_) { /* Storage is optional. */ }
    setMode(invite?.existingAccount ? 'signin' : 'signup');
    await refresh();
  });
  $('#setup-email-resend').addEventListener('click', async (event) => {
    if (!pendingEmail || operationInFlight) return;
    if (Date.now() < emailResendAt) return notice('Please wait one minute between confirmation emails. Use the most recent email link.');
    const button = event.currentTarget;
    button.disabled = true; operationInFlight = true;
    try {
      const { error } = await Portal.db.auth.resend({ type: 'signup', email: pendingEmail, options: { emailRedirectTo: redirectTo } });
      if (error) throw error;
      emailResendAt = Date.now() + 60_000;
      notice('Confirmation requested. Check your inbox and spam folder, and use only the latest email link.');
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; operationInFlight = false; }
  });
  $('#setup-magic-link').addEventListener('click', async (event) => {
    const email = $('#setup-email').value.trim().toLowerCase();
    if (!email || !$('#setup-email').checkValidity()) return notice('Enter your existing account email first.');
    const button = event.currentTarget; button.disabled = true;
    try {
      const { error } = await Portal.db.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: false } });
      if (error) throw error;
      notice('Open the sign-in email, then return to this tab or reopen your original setup text. Phone verification is still required.');
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; }
  });

  function startResendTimer(seconds = 60) {
    resendAt = Date.now() + Math.max(60, seconds) * 1000;
    clearInterval(resendTimer);
    const tick = () => {
      const left = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      $('#setup-send-code').disabled = left > 0;
      $('#setup-send-code').textContent = left ? `Resend in ${left}s` : 'Text me another code';
      if (!left) clearInterval(resendTimer);
    };
    tick(); resendTimer = setInterval(tick, 1000);
  }
  $('#setup-send-code').addEventListener('click', async () => {
    if (Date.now() < resendAt || operationInFlight) return;
    $('#setup-send-code').disabled = true; operationInFlight = true;
    notice('Sending your private verification code…');
    try {
      const result = await Portal.adminAccess('send-code', inviteToken ? { inviteToken } : invite ? { resumeInvite: true } : {});
      challengeId = result.challengeId; startResendTimer(result.retryAfter);
      $('#setup-code').value = ''; $('#setup-code-form').hidden = false; $('#setup-code').focus();
      notice(`Code sent to ${result.phoneMasked}. Enter it below within 5 minutes.`);
    } catch (error) {
      notice(error.message);
      if (error.retryAfter) startResendTimer(error.retryAfter); else $('#setup-send-code').disabled = false;
    } finally { operationInFlight = false; }
  });
  $('#setup-code-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('#setup-code').value.trim();
    if (operationInFlight) return;
    if (!challengeId || !/^\d{6}$/.test(code)) return notice('Enter the 6-digit code from your latest text.');
    const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; operationInFlight = true;
    let verified = false;
    try {
      await Portal.adminAccess('verify-code', { challengeId, code });
      clearInvite(); challengeId = ''; $('#setup-code').value = ''; $('#setup-code-form').hidden = true;
      verified = true;
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; operationInFlight = false; }
    if (verified) { await refresh(); notice('Phone verified. Your full admin access is ready.'); }
  });

  async function requireVerifiedPhone() {
    const revision = epoch;
    const status = await Portal.adminAccess('status');
    if (revision !== epoch) throw new Error('Your sign-in changed. Please sign in and verify again.');
    if (!status.isAdmin || !status.verified || status.requiresVerification !== true) throw new Error('Verify your phone before changing account security.');
    scheduleExpiry(status); return status;
  }
  $('#setup-security-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (operationInFlight) return;
    const email = $('#security-email').value.trim().toLowerCase();
    const password = $('#security-password').value;
    if (!email && !password) return notice('Enter a new email or password to make a change.');
    if (password && (password.length < 12 || password !== $('#security-password-confirm').value)) return notice('Use at least 12 characters and make sure the new passwords match.');
    const button = event.currentTarget.querySelector('[type="submit"]'); button.disabled = true; operationInFlight = true;
    const revision = epoch;
    try {
      await requireVerifiedPhone();
      if (revision !== epoch) throw new Error('Your sign-in changed. Please sign in and verify again.');
      const attributes = { ...(email ? { email } : {}), ...(password ? { password } : {}) };
      const nonce = $('#security-nonce').value.trim(); if (nonce) attributes.nonce = nonce;
      const { error } = await Portal.db.auth.updateUser(attributes, { emailRedirectTo: redirectTo });
      if (error) throw error;
      $('#security-email').value = ''; $('#security-reauth').hidden = true;
      notice(email ? `${password ? 'Password updated. ' : ''}Check the confirmation emails sent to your old and new email addresses to finish changing your email. Your account and admin access stay the same.` : 'Your password was updated. Use your new password the next time you sign in.');
    } catch (error) {
      if (/reauthentication|reauthenticate|nonce/i.test(`${error.code || ''} ${error.message}`)) $('#security-reauth').hidden = false;
      notice(error.message);
    } finally { clearSecrets(); button.disabled = false; operationInFlight = false; }
  });
  $('#security-reauth-send').addEventListener('click', async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await requireVerifiedPhone();
      const { error } = await Portal.db.auth.reauthenticate(); if (error) throw error;
      notice('Supabase sent an account-confirmation code to your email. Enter that code and your new password, then save again.');
    } catch (error) { notice(error.message); }
    finally { button.disabled = false; }
  });

  $('#setup-invite-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('[type="submit"]');
    if (button.disabled) return;
    const name = $('#invite-name').value.trim();
    const rawPhone = $('#invite-phone').value.trim();
    const digits = rawPhone.replace(/\D/g, '');
    const phone = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    if (!name || !/^\+1\d{10}$/.test(phone)) return $('#setup-invite-status').textContent = 'Enter a name and a valid US mobile number.';
    button.disabled = true;
    const revision = epoch;
    $('#setup-invite-status').textContent = 'Creating and texting the secure setup link…';
    try {
      const currentSession = await Portal.getSession();
      const status = await Portal.adminAccess('status');
      if (revision !== epoch) throw new Error('Your sign-in changed. Please sign in and verify again.');
      if (!currentSession || !status.isAdmin || !status.verified) throw new Error('Sign in and complete verification before inviting an administrator.');
      const result = await Portal.adminAccess('invite-create', { name, phone, ...($('#invite-current-account').checked ? { existingUserId: currentSession.user.id } : {}) });
      $('#setup-invite-status').textContent = `Quo accepted the setup text for ${result.phoneMasked}. Delivery can take a moment. The private link expires ${new Date(result.expiresAt).toLocaleString()}.`;
      form.reset();
    } catch (error) { $('#setup-invite-status').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#setup-signout').addEventListener('click', async () => {
    epoch += 1; hideSections(); clearSecrets(); clearTimeout(expiryTimer); clearInterval(resendTimer);
    challengeId = ''; access = null; $('#setup-code-form').hidden = true; notice('Signing out…');
    try { await Portal.signOutAdmin(); }
    catch (error) { notice(error.message); }
    await refresh();
  });
  Portal.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { epoch += 1; hideSections(); clearSecrets(); access = null; }
    if (['SIGNED_IN', 'SIGNED_OUT', 'TOKEN_REFRESHED'].includes(event)) setTimeout(refresh, 0);
  });
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && access?.verified) refresh(); }, 60_000);
  refresh();
})();
