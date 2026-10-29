-- Production migration version matches Supabase history: 20261029201900.
-- Custom Quo SMS verification is an application authorization layer, not Supabase
-- native AAL2. Every admin RLS policy already calls is_workspace_admin(); replace
-- its email allowlist with immutable user membership and session-scoped leases.
create table private.admin_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active boolean not null default true,
  approved_phone text unique check (approved_phone ~ '^\+[1-9][0-9]{7,14}$'),
  sms_required boolean not null default true,
  enrolled_at timestamptz,
  created_at timestamptz not null default now(),
  check (not sms_required or approved_phone is not null)
);
create table private.admin_invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  display_name text not null check (char_length(display_name) between 1 and 120),
  existing_user_id uuid references auth.users(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '48 hours',
  sent_at timestamptz,
  message_id text,
  consumed_at timestamptz,
  consumed_by uuid references auth.users(id),
  revoked_at timestamptz
);
create index admin_invitations_phone_created on private.admin_invitations(phone, created_at desc);
create index admin_invitations_actor_created on private.admin_invitations(created_by, created_at desc);
create index admin_invitations_existing_user on private.admin_invitations(existing_user_id);
create index admin_invitations_consumed_by on private.admin_invitations(consumed_by);
create table private.admin_sms_challenges (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Retain rate-limit history after sign-out; deleting a session must not reset
  -- its phone/IP send counters. A detached challenge can never be verified.
  session_id uuid references auth.sessions(id) on delete set null,
  invite_id uuid references private.admin_invitations(id) on delete cascade,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  delivered_at timestamptz,
  message_id text,
  consumed_at timestamptz,
  revoked_at timestamptz
);
create index admin_sms_challenges_phone_created on private.admin_sms_challenges(phone, created_at desc);
create index admin_sms_challenges_user_created on private.admin_sms_challenges(user_id, created_at desc);
create index admin_sms_challenges_ip_created on private.admin_sms_challenges(ip_hash, created_at desc);
create index admin_sms_challenges_session on private.admin_sms_challenges(session_id);
create index admin_sms_challenges_invite on private.admin_sms_challenges(invite_id);
create table private.admin_session_leases (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references private.admin_memberships(user_id) on delete cascade,
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index admin_session_leases_user on private.admin_session_leases(user_id);
alter table private.admin_memberships enable row level security;
alter table private.admin_invitations enable row level security;
alter table private.admin_sms_challenges enable row level security;
alter table private.admin_session_leases enable row level security;
revoke all on private.admin_memberships, private.admin_invitations, private.admin_sms_challenges, private.admin_session_leases from public, anon, authenticated, service_role;

-- One-time migration only: changing an email later never grants admin access.
-- Existing admins keep working until each completes their own enrollment.
insert into private.admin_memberships(user_id, sms_required)
select u.id, false from auth.users u join private.workspace_admins a on lower(u.email) = lower(a.email)
where u.deleted_at is null on conflict (user_id) do nothing;
revoke all on private.workspace_admins from authenticated, anon;

create function private.admin_auth_session_id()
returns uuid language plpgsql stable security invoker set search_path = '' as $$
begin
  return nullif(auth.jwt()->>'session_id', '')::uuid;
exception when invalid_text_representation then return null;
end;
$$;

create function private.admin_auth_live_session(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select p_user_id is not null and p_session_id is not null and exists (
    select 1 from auth.sessions s join auth.users u on u.id = s.user_id
    where s.id = p_session_id and s.user_id = p_user_id
      and (s.not_after is null or s.not_after > now())
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and u.email_confirmed_at is not null
  );
$$;

create function private.admin_auth_allowed(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.admin_auth_live_session(p_user_id, p_session_id) and exists (select 1 from private.admin_memberships m join auth.users u on u.id = m.user_id
    where m.user_id = p_user_id and m.active and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= now())
      and (not m.sms_required or (
        private.admin_auth_live_session(p_user_id, p_session_id)
        and exists (select 1 from private.admin_session_leases l
          where l.user_id = p_user_id and l.session_id = p_session_id
            and l.revoked_at is null and l.expires_at > now())
      )));
$$;

create or replace function private.is_workspace_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and private.admin_auth_allowed(auth.uid(), private.admin_auth_session_id());
$$;
create or replace function public.current_user_role()
returns text language sql stable security invoker set search_path = '' as $$
  select case when private.is_workspace_admin() then 'admin' else 'client' end;
$$;

create function private.admin_auth_status_value(p_user_id uuid, p_session_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('ok', true,
    'isAdmin', coalesce(m.active, false),
    'requiresVerification', coalesce(m.active and m.sms_required, false),
    'verified', private.admin_auth_allowed(p_user_id, p_session_id),
    'phoneMasked', case when m.approved_phone is null then null else '***-***-' || right(m.approved_phone, 4) end,
    'expiresAt', (select l.expires_at from private.admin_session_leases l where l.user_id=p_user_id and l.session_id=p_session_id and l.revoked_at is null and l.expires_at > now()))
  from (select 1) seed left join private.admin_memberships m on m.user_id=p_user_id;
$$;
create function private.admin_auth_self_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.admin_auth_live_session(auth.uid(),private.admin_auth_session_id()) then return jsonb_build_object('ok',false,'error','unauthorized_session'); end if;
  return private.admin_auth_status_value(auth.uid(), private.admin_auth_session_id());
end;
$$;
create function public.admin_auth_self_status()
returns jsonb language sql stable security invoker set search_path = '' as $$ select private.admin_auth_self_status(); $$;

-- SECURITY DEFINER implementations stay private. SQL role (set by PostgREST),
-- not a user-editable claim, authenticates all privileged service entry points.
create function private.admin_auth_require_service()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if current_setting('role', true) is distinct from 'service_role' then
    raise exception 'Server-only operation' using errcode='42501';
  end if;
end;
$$;
create function private.admin_auth_status(p_user_id uuid, p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.admin_auth_require_service();
  if not private.admin_auth_live_session(p_user_id,p_session_id) then
    return jsonb_build_object('ok',false,'error','unauthorized_session');
  end if;
  return private.admin_auth_status_value(p_user_id,p_session_id);
end;
$$;

create function private.admin_auth_create_invite(p_actor_id uuid, p_actor_session_id uuid, p_phone text, p_name text, p_existing_user_id uuid, p_invite_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare invitation private.admin_invitations; member private.admin_memberships;
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  if not private.admin_auth_live_session(p_actor_id,p_actor_session_id) or not private.admin_auth_allowed(p_actor_id,p_actor_session_id) then
    return jsonb_build_object('ok',false,'error','forbidden');
  end if;
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' or p_invite_hash is null or p_invite_hash !~ '^[a-f0-9]{64}$'
    or coalesce(char_length(btrim(p_name)),0) not between 1 and 120 then return jsonb_build_object('ok',false,'error','invalid_request'); end if;
  select * into member from private.admin_memberships where user_id=p_existing_user_id;
  if (p_existing_user_id is not null and (p_existing_user_id <> p_actor_id or member.user_id is null or not member.active))
    or (member.approved_phone is not null and member.approved_phone <> p_phone)
    or exists (select 1 from private.admin_memberships m where m.approved_phone=p_phone and m.user_id is distinct from p_existing_user_id) then
    return jsonb_build_object('ok',false,'error','conflict');
  end if;
  if exists (select 1 from private.admin_invitations i where i.phone=p_phone and i.created_at > now()-interval '60 seconds')
    or (select count(*) from private.admin_invitations i where i.phone=p_phone and i.created_at > now()-interval '1 hour') >= 5
    or (select count(*) from private.admin_invitations i where i.created_by=p_actor_id and i.created_at > now()-interval '1 hour') >= 10 then
    return jsonb_build_object('ok',false,'error','rate_limited','retryAfterSeconds',60);
  end if;
  update private.admin_invitations set revoked_at=now() where phone=p_phone and consumed_at is null and revoked_at is null;
  insert into private.admin_invitations(token_hash,phone,display_name,existing_user_id,created_by)
    values (p_invite_hash,p_phone,btrim(p_name),p_existing_user_id,p_actor_id) returning * into invitation;
  return jsonb_build_object('ok',true,'inviteId',invitation.id,'phone',invitation.phone,'expiresAt',invitation.expires_at);
end;
$$;
create function private.admin_auth_invite_info(p_token_hash text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare invitation private.admin_invitations;
begin
  perform private.admin_auth_require_service();
  select * into invitation from private.admin_invitations where token_hash=p_token_hash and consumed_at is null and revoked_at is null and expires_at>now() and sent_at is not null;
  if invitation.id is null then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
  return jsonb_build_object('ok',true,'name',invitation.display_name,'phoneMasked','***-***-'||right(invitation.phone,4),
    'existingUserId',invitation.existing_user_id,'expiresAt',invitation.expires_at);
end;
$$;
create function private.admin_auth_invite_delivery(p_invite_id uuid, p_message_id text, p_sent boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  if p_sent and coalesce(char_length(p_message_id),0) not between 1 and 200 then return jsonb_build_object('ok',false,'error','invalid_request'); end if;
  update private.admin_invitations set sent_at=case when p_sent then now() end,
    message_id=case when p_sent then p_message_id end, revoked_at=case when p_sent then null else now() end
    where id=p_invite_id and consumed_at is null and revoked_at is null and sent_at is null and expires_at>now();
  return jsonb_build_object('ok',found);
end;
$$;

create function private.admin_auth_begin_challenge(p_user_id uuid, p_session_id uuid, p_invite_hash text, p_challenge_id uuid, p_code_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare invitation private.admin_invitations; member private.admin_memberships; target_phone text; last_send timestamptz; challenge private.admin_sms_challenges;
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  if not private.admin_auth_live_session(p_user_id,p_session_id) then
    return jsonb_build_object('ok',false,'error','unauthorized_session');
  end if;
  if p_challenge_id is null or p_code_hash is null or p_code_hash !~ '^[a-f0-9]{64}$' or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok',false,'error','invalid_request');
  end if;
  select * into member from private.admin_memberships where user_id=p_user_id;
  if p_invite_hash is not null then
    select * into invitation from private.admin_invitations where token_hash=p_invite_hash and consumed_at is null and revoked_at is null and expires_at>now() and sent_at is not null for update;
    if invitation.id is null or (invitation.existing_user_id is not null and invitation.existing_user_id <> p_user_id)
      or (invitation.existing_user_id is null and member.user_id is not null) then
      return jsonb_build_object('ok',false,'error','invalid_invite');
    end if;
    if not exists (select 1 from auth.users where id=p_user_id and email_confirmed_at is not null and coalesce(encrypted_password,'') <> '') then
      return jsonb_build_object('ok',false,'error','email_unconfirmed');
    end if;
    if (member.user_id is not null and not member.active) or (member.approved_phone is not null and member.approved_phone <> invitation.phone)
      or exists (select 1 from private.admin_memberships where approved_phone=invitation.phone and user_id<>p_user_id) then
      return jsonb_build_object('ok',false,'error','conflict');
    end if;
    target_phone := invitation.phone;
  else
    if member.user_id is null or not member.active or member.approved_phone is null then return jsonb_build_object('ok',false,'error','forbidden'); end if;
    target_phone := member.approved_phone;
  end if;
  select max(created_at) into last_send from private.admin_sms_challenges where phone=target_phone or user_id=p_user_id;
  if last_send > now()-interval '60 seconds' then
    return jsonb_build_object('ok',false,'error','rate_limited','retryAfterSeconds',greatest(1,ceil(extract(epoch from last_send+interval '60 seconds'-now()))::integer));
  end if;
  if (select count(*) from private.admin_sms_challenges where phone=target_phone and created_at>now()-interval '1 hour')>=5
    or (select count(*) from private.admin_sms_challenges where user_id=p_user_id and created_at>now()-interval '1 hour')>=5
    or (select count(*) from private.admin_sms_challenges where ip_hash=p_ip_hash and created_at>now()-interval '1 hour')>=10 then
    return jsonb_build_object('ok',false,'error','rate_limited','retryAfterSeconds',3600);
  end if;
  update private.admin_sms_challenges set revoked_at=now() where (user_id=p_user_id or phone=target_phone) and consumed_at is null and revoked_at is null;
  insert into private.admin_sms_challenges(id,user_id,session_id,invite_id,phone,code_hash,ip_hash)
    values(p_challenge_id,p_user_id,p_session_id,invitation.id,target_phone,p_code_hash,p_ip_hash) returning * into challenge;
  return jsonb_build_object('ok',true,'challengeId',challenge.id,'phone',target_phone,'phoneMasked','***-***-'||right(target_phone,4),'expiresAt',challenge.expires_at,'retryAfterSeconds',60);
end;
$$;
create function private.admin_auth_confirm_delivery(p_challenge_id uuid, p_message_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  if coalesce(char_length(p_message_id),0) not between 1 and 200 then return jsonb_build_object('ok',false,'error','invalid_request'); end if;
  update private.admin_sms_challenges set delivered_at=now(),message_id=p_message_id where id=p_challenge_id and consumed_at is null and revoked_at is null and delivered_at is null and expires_at>now();
  return jsonb_build_object('ok',found);
end;
$$;
create function private.admin_auth_cancel_challenge(p_challenge_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  update private.admin_sms_challenges set revoked_at=now() where id=p_challenge_id and consumed_at is null and revoked_at is null;
  return jsonb_build_object('ok',true);
end;
$$;
create function private.admin_auth_verify_code(p_user_id uuid, p_session_id uuid, p_challenge_id uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare challenge private.admin_sms_challenges; invitation private.admin_invitations; member private.admin_memberships; lease_expiry timestamptz;
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  if not private.admin_auth_live_session(p_user_id,p_session_id) then return jsonb_build_object('ok',false,'error','unauthorized_session'); end if;
  select * into challenge from private.admin_sms_challenges where id=p_challenge_id and user_id=p_user_id and session_id=p_session_id for update;
  if challenge.id is null or challenge.revoked_at is not null or challenge.consumed_at is not null then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
  if challenge.expires_at<=now() then return jsonb_build_object('ok',false,'error','expired_code'); end if;
  if challenge.attempts>=5 then return jsonb_build_object('ok',false,'error','attempts_exhausted'); end if;
  if challenge.delivered_at is null then return jsonb_build_object('ok',false,'error','delivery_pending'); end if;
  if p_code_hash is null or p_code_hash is distinct from challenge.code_hash then
    update private.admin_sms_challenges set attempts=attempts+1 where id=challenge.id;
    return jsonb_build_object('ok',false,'error',case when challenge.attempts>=4 then 'attempts_exhausted' else 'invalid_code' end);
  end if;
  select * into member from private.admin_memberships where user_id=p_user_id for update;
  if challenge.invite_id is not null then
    select * into invitation from private.admin_invitations where id=challenge.invite_id for update;
    if invitation.revoked_at is not null or invitation.consumed_at is not null or invitation.expires_at<=now() or invitation.sent_at is null
      or invitation.phone<>challenge.phone or (invitation.existing_user_id is not null and invitation.existing_user_id<>p_user_id)
      or (invitation.existing_user_id is null and member.user_id is not null) then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
    if not exists (select 1 from auth.users where id=p_user_id and email_confirmed_at is not null and coalesce(encrypted_password,'')<>'') then
      return jsonb_build_object('ok',false,'error','email_unconfirmed'); end if;
    if (member.user_id is not null and not member.active) or (member.approved_phone is not null and member.approved_phone<>challenge.phone)
      or exists (select 1 from private.admin_memberships where approved_phone=challenge.phone and user_id<>p_user_id) then
      return jsonb_build_object('ok',false,'error','conflict'); end if;
    insert into private.admin_memberships(user_id,approved_phone,sms_required,enrolled_at)
      values(p_user_id,challenge.phone,true,now()) on conflict(user_id) do update set approved_phone=excluded.approved_phone,sms_required=true,enrolled_at=now();
    update private.admin_invitations set consumed_at=now(),consumed_by=p_user_id where id=invitation.id;
    -- Enrollment replaces the old single-factor access, including any former lease.
    update private.admin_session_leases set revoked_at=now() where user_id=p_user_id and revoked_at is null;
  elsif member.user_id is null or not member.active or member.approved_phone is distinct from challenge.phone then
    return jsonb_build_object('ok',false,'error','forbidden');
  end if;
  select least(now()+interval '8 hours',coalesce(not_after,'infinity'::timestamptz)) into lease_expiry from auth.sessions where id=p_session_id and user_id=p_user_id;
  insert into private.admin_session_leases(session_id,user_id,expires_at) values(p_session_id,p_user_id,lease_expiry)
    on conflict(session_id) do update set user_id=excluded.user_id,verified_at=now(),expires_at=excluded.expires_at,revoked_at=null;
  update private.admin_sms_challenges set consumed_at=now() where id=challenge.id;
  return jsonb_build_object('ok',true,'verified',true,'expiresAt',lease_expiry);
end;
$$;
create function private.admin_auth_revoke(p_user_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.admin_auth_require_service();
  perform pg_advisory_xact_lock(hashtextextended('launchpoint-admin-auth',0));
  if not private.admin_auth_live_session(p_user_id,p_session_id) then return jsonb_build_object('ok',false,'error','unauthorized_session'); end if;
  update private.admin_session_leases set revoked_at=now() where user_id=p_user_id and session_id=p_session_id and revoked_at is null;
  update private.admin_sms_challenges set revoked_at=now() where user_id=p_user_id and session_id=p_session_id and consumed_at is null and revoked_at is null;
  return jsonb_build_object('ok',true);
end;
$$;

-- Exposed wrappers cannot themselves bypass RLS; only service_role can enter the
-- privileged implementations. No challenge hashes, full phones or invites are
-- selectable by a browser, including an already verified admin browser.
create function public.admin_auth_status(p_user_id uuid,p_session_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select private.admin_auth_status(p_user_id,p_session_id); $$;
create function public.admin_auth_create_invite(p_actor_id uuid,p_actor_session_id uuid,p_phone text,p_name text,p_existing_user_id uuid,p_invite_hash text) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_create_invite(p_actor_id,p_actor_session_id,p_phone,p_name,p_existing_user_id,p_invite_hash); $$;
create function public.admin_auth_invite_info(p_token_hash text) returns jsonb language sql stable security invoker set search_path='' as $$ select private.admin_auth_invite_info(p_token_hash); $$;
create function public.admin_auth_invite_delivery(p_invite_id uuid,p_message_id text,p_sent boolean) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_invite_delivery(p_invite_id,p_message_id,p_sent); $$;
create function public.admin_auth_begin_challenge(p_user_id uuid,p_session_id uuid,p_invite_hash text,p_challenge_id uuid,p_code_hash text,p_ip_hash text) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_begin_challenge(p_user_id,p_session_id,p_invite_hash,p_challenge_id,p_code_hash,p_ip_hash); $$;
create function public.admin_auth_confirm_delivery(p_challenge_id uuid,p_message_id text) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_confirm_delivery(p_challenge_id,p_message_id); $$;
create function public.admin_auth_cancel_challenge(p_challenge_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_cancel_challenge(p_challenge_id); $$;
create function public.admin_auth_verify_code(p_user_id uuid,p_session_id uuid,p_challenge_id uuid,p_code_hash text) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_verify_code(p_user_id,p_session_id,p_challenge_id,p_code_hash); $$;
create function public.admin_auth_revoke(p_user_id uuid,p_session_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select private.admin_auth_revoke(p_user_id,p_session_id); $$;

-- Explicit grants also cover private functions: PUBLIC EXECUTE is never retained.
do $$ declare fn record; begin
  for fn in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('private','public') and p.proname like 'admin_auth_%'
  loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
    if fn.proname='admin_auth_self_status' then
      execute format('grant execute on function %s to authenticated',fn.signature);
    elsif fn.proname in ('admin_auth_status','admin_auth_create_invite','admin_auth_invite_info','admin_auth_invite_delivery','admin_auth_begin_challenge','admin_auth_confirm_delivery','admin_auth_cancel_challenge','admin_auth_verify_code','admin_auth_revoke') then
      execute format('grant execute on function %s to service_role',fn.signature);
    end if;
  end loop;
end $$;
grant usage on schema private to service_role;
revoke all on function private.is_workspace_admin(), public.current_user_role() from public,anon;
grant execute on function private.is_workspace_admin(), public.current_user_role() to authenticated;
