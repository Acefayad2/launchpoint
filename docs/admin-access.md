# LaunchPoint administrator access

The production URL is `https://mylaunch.dev/admin-setup.html`. Administrator invitations are sent through the configured LaunchPoint Quo number. They expire after 48 hours, use a random fragment token, and do not grant access merely by opening the link.

New administrators choose their own email and password through Supabase Auth, confirm their email, and prove possession of the invited phone. Existing-account invitations are bound to the inviting account's UUID. Email changes preserve that UUID and its project permissions.

## Verification boundary

This is an application authorization layer, **not Supabase native AAL2**. Supabase handles password/email authentication and its own account-change protections. Quo delivers codes; it does not validate them. LaunchPoint's server and private database functions verify them and gate administrator database access, Storage policies, and payment-management endpoints through the shared admin-role helper.

Codes expire after five minutes, permit five wrong attempts, and can be used once. Sending is limited by account, phone, and trusted client IP. A verified lease lasts at most eight hours and is tied to one live Supabase session. Logout, revocation, expiry, deleted sessions, and inactive memberships invalidate access. Raw codes, invitation tokens, and passwords must never be logged or committed.

Existing allowlisted accounts were migrated to UUID memberships with phone enforcement initially disabled. Each account switches to required phone verification only after completing its own enrollment. Newly invited administrators always require phone verification. Never treat migration completion as proof that users have enrolled.

## Operations

- `ADMIN_AUTH_SECRET`: cryptographically random, at least 32 characters; production encrypted server environment only. Rotating it invalidates pending OTP challenges, not existing leases or invitations.
- Existing `SUPABASE_SERVICE_ROLE_KEY`, `QUO_API_KEY`, and `QUO_FROM_NUMBER` remain server-side. No paid native SMS-MFA add-on is required.
- API message acceptance is not proof of delivery. Check Quo delivery status before reporting delivery.
- A lost phone must not trigger an email-only bypass. Verify identity out of band and use an explicitly approved, narrowly scoped recovery procedure. The self-service page intentionally cannot change the approved phone or deactivate another administrator.
- SMS is vulnerable to SIM swaps and Quo inbox/account compromise. Users with access to the Quo inbox may see verification messages. Use strong unique passwords and protect the Quo account.
- Password and email updates go directly to Supabase Auth; the custom lease does not add native MFA enforcement to Supabase's account-update API.

## Verification and release

Run `npm test`, `npm run build`, and the Netlify function build. The SQL suites in `tests/admin-access-rls.sql` and `tests/project-workspace-rls.sql` create collision-checked synthetic fixtures in a transaction and finish with `ROLLBACK`; run the complete batch, never commit it.

Production publishes only `dist/`. Backend functions are bundled separately; migrations, tests, documentation, local output, and secrets are not web assets. Deploy from `main` and verify the canonical site's admin API, setup page, existing admin dashboard, and invoice route before sending invitations. Recipients complete their own passwords and verification codes privately.
