-- Run as database owner AFTER the Quo admin-access migration, as one whole batch.
-- Synthetic rows only; no provider, email, SMS, Auth API or payment calls. ROLLBACK
-- is intentional. A failed assertion aborts this transaction; do not COMMIT it.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
create temporary table admin_access_rls_results(check_name text primary key) on commit drop;
grant select,insert on admin_access_rls_results to authenticated,anon,service_role;
create temporary table admin_access_test_values(key text primary key,value jsonb) on commit drop;
grant select,insert,update on admin_access_test_values to service_role;
do $$ begin
  if exists(select 1 from auth.users where id::text like 'fa100000-%' or email like 'lp-admin-rls-%@example.invalid')
    or exists(select 1 from public.clients where id='fa300000-0000-4000-8000-000000000001' or slug='lp-admin-rls-project') then
    raise exception 'Test fixture collision; choose fresh fixture IDs, never overwrite existing data';
  end if;
end $$;
insert into auth.users(id,email,aud,role,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values
 ('fa100000-0000-4000-8000-000000000001','lp-admin-rls-owner@example.invalid','authenticated','authenticated','fixture-not-a-real-password-hash',now(),now(),now(),'{}','{}'),
 ('fa100000-0000-4000-8000-000000000002','lp-admin-rls-new@example.invalid','authenticated','authenticated','fixture-not-a-real-password-hash',now(),now(),now(),'{}','{}'),
 ('fa100000-0000-4000-8000-000000000003','lp-admin-rls-outsider@example.invalid','authenticated','authenticated','fixture-not-a-real-password-hash',now(),now(),now(),'{}','{}'),
 ('fa100000-0000-4000-8000-000000000004','lp-admin-rls-unconfirmed@example.invalid','authenticated','authenticated','fixture-not-a-real-password-hash',null,now(),now(),'{}','{}');
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('fa200000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000001',now(),now()),
 ('fa200000-0000-4000-8000-000000000011','fa100000-0000-4000-8000-000000000001',now(),now()),
 ('fa200000-0000-4000-8000-000000000002','fa100000-0000-4000-8000-000000000002',now(),now()),
 ('fa200000-0000-4000-8000-000000000012','fa100000-0000-4000-8000-000000000002',now(),now()),
 ('fa200000-0000-4000-8000-000000000003','fa100000-0000-4000-8000-000000000003',now(),now()),
 ('fa200000-0000-4000-8000-000000000004','fa100000-0000-4000-8000-000000000004',now(),now());
insert into private.workspace_admins(email) values ('lp-admin-rls-owner@example.invalid');
insert into private.admin_memberships(user_id,sms_required) values ('fa100000-0000-4000-8000-000000000001',false);
insert into public.clients(id,slug,business,project,status,next_step) values
 ('fa300000-0000-4000-8000-000000000001','lp-admin-rls-project','Private admin fixture','SMS gate fixture','active','Review');

set local role authenticated;
set local request.jwt.claim.sub='fa100000-0000-4000-8000-000000000003';
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000003","email":"lp-admin-rls-owner@example.invalid","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000003","user_metadata":{"role":"admin"}}';
do $$ begin
  if private.is_workspace_admin() or public.current_user_role()<>'client'
    or exists(select 1 from public.clients where id='fa300000-0000-4000-8000-000000000001') then raise exception 'Email or editable metadata granted admin'; end if;
  begin perform public.admin_auth_status('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001');
    raise exception 'Browser invoked service RPC'; exception when insufficient_privilege then null; end;
  begin perform 1 from private.admin_memberships;
    raise exception 'Browser read private memberships'; exception when insufficient_privilege then null; end;
  begin perform private.admin_auth_require_service();
    raise exception 'Browser entered privileged implementation'; exception when insufficient_privilege then null; end;
  insert into admin_access_rls_results values ('UUID identity defeats spoofed email/user_metadata; browser cannot read private records or call service functions');
end $$;
set local request.jwt.claim.sub='fa100000-0000-4000-8000-000000000001';
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000001","email":"changed-owner@example.invalid","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000001"}';
do $$ begin
  if not private.is_workspace_admin() or public.current_user_role()<>'admin' or not (public.admin_auth_self_status()->>'verified')::boolean
    or not exists(select 1 from public.clients where id='fa300000-0000-4000-8000-000000000001') then raise exception 'Legacy UUID admin or email change preservation failed'; end if;
  insert into admin_access_rls_results values ('Existing admin preserves access until enrollment; email changes cannot remove immutable membership');
end $$;

set local role service_role;
do $$ declare r jsonb; begin
  r:=public.admin_auth_status('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000003');
  if r->>'error'<>'unauthorized_session' then raise exception 'Foreign session accepted'; end if;
  r:=public.admin_auth_create_invite('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','+15555550101','Owner','fa100000-0000-4000-8000-000000000001',repeat('a',64));
  if not (r->>'ok')::boolean then raise exception 'Owner invitation failed: %',r; end if;
  insert into admin_access_test_values values ('owner_invite',r);
  if public.admin_auth_invite_info(repeat('a',64))->>'error'<>'invalid_invite' then raise exception 'Unsent invite usable'; end if;
  perform public.admin_auth_invite_delivery((r->>'inviteId')::uuid,'fixture-owner-invite',true);
  r:=public.admin_auth_create_invite('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','+15555550102','New admin',null,repeat('b',64));
  if not (r->>'ok')::boolean then raise exception 'New invitation failed: %',r; end if;
  insert into admin_access_test_values values ('new_invite',r);
  perform public.admin_auth_invite_delivery((r->>'inviteId')::uuid,'fixture-new-invite',true);
  if public.admin_auth_invite_info(repeat('b',64))->>'name'<>'New admin' then raise exception 'Sent invite unavailable'; end if;
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000003','fa200000-0000-4000-8000-000000000003',repeat('a',64),'fa400000-0000-4000-8000-000000000099',repeat('c',64),repeat('d',64));
  if r->>'error'<>'invalid_invite' then raise exception 'Existing-user invitation claimed by different identity'; end if;
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000004','fa200000-0000-4000-8000-000000000004',repeat('b',64),'fa400000-0000-4000-8000-000000000099',repeat('c',64),repeat('d',64));
  if r->>'error'<>'unauthorized_session' then raise exception 'Unconfirmed email admitted'; end if;
  insert into admin_access_rls_results values ('Invites require verified admin actor, provider acceptance, confirmed email, and exact existing-user binding');
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002',repeat('b',64),'fa400000-0000-4000-8000-000000000001',repeat('c',64),repeat('d',64));
  if not (r->>'ok')::boolean or r->>'phone'<>'+15555550102' then raise exception 'Enrollment challenge failed: %',r; end if;
  if public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002','fa400000-0000-4000-8000-000000000001',repeat('c',64))->>'error'<>'delivery_pending' then raise exception 'Undelivered code accepted'; end if;
  perform public.admin_auth_confirm_delivery('fa400000-0000-4000-8000-000000000001','fixture-code-1');
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002',repeat('b',64),'fa400000-0000-4000-8000-000000000099',repeat('c',64),repeat('d',64));
  if r->>'error'<>'rate_limited' then raise exception '60-second resend limit bypassed'; end if;
  for i in 1..5 loop
    r:=public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002','fa400000-0000-4000-8000-000000000001',repeat('e',64));
    if (r->>'ok')::boolean then raise exception 'Wrong code accepted'; end if;
  end loop;
  if public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002','fa400000-0000-4000-8000-000000000001',repeat('c',64))->>'error'<>'attempts_exhausted' then raise exception 'Correct code bypassed exhausted attempt limit'; end if;
  insert into admin_access_rls_results values ('Codes require delivery; cooldown and five wrong-attempt lockout persist across RPC calls');
end $$;
reset role;
do $$ begin
  if (select attempts from private.admin_sms_challenges where id='fa400000-0000-4000-8000-000000000001')<>5 then raise exception 'Wrong attempts rolled back'; end if;
end $$;
update private.admin_sms_challenges set created_at=now()-interval '61 seconds' where id='fa400000-0000-4000-8000-000000000001';
set local role service_role;
do $$ declare r jsonb; begin
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002',repeat('b',64),'fa400000-0000-4000-8000-000000000002',repeat('f',64),repeat('d',64));
  if not (r->>'ok')::boolean then raise exception 'Resend after cooldown failed: %',r; end if;
  perform public.admin_auth_confirm_delivery('fa400000-0000-4000-8000-000000000002','fixture-code-2');
  r:=public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000012','fa400000-0000-4000-8000-000000000002',repeat('f',64));
  if r->>'error'<>'invalid_code' then raise exception 'OTP accepted in another session'; end if;
  r:=public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002','fa400000-0000-4000-8000-000000000002',repeat('f',64));
  if not (r->>'verified')::boolean or (r->>'expiresAt')::timestamptz>now()+interval '8 hours' then raise exception 'Valid enrollment or lease failed: %',r; end if;
  if public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002','fa400000-0000-4000-8000-000000000002',repeat('f',64))->>'error'<>'invalid_code'
    or public.admin_auth_invite_info(repeat('b',64))->>'error'<>'invalid_invite' then raise exception 'OTP or invitation replay succeeded'; end if;
  insert into admin_access_rls_results values ('Valid OTP atomically consumes code and invite, creates equal admin membership and eight-hour session lease; replay fails');
end $$;
set local role authenticated;
set local request.jwt.claim.sub='fa100000-0000-4000-8000-000000000002';
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000002","email":"lp-admin-rls-new@example.invalid","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000002"}';
do $$ declare changed integer; begin
  if not private.is_workspace_admin() or public.current_user_role()<>'admin' then raise exception 'Enrolled admin lacks role'; end if;
  update public.clients set business='Verified admin edit' where id='fa300000-0000-4000-8000-000000000001';
  get diagnostics changed=row_count;
  if changed<>1 then raise exception 'Verified admin lacks equal write access'; end if;
  insert into admin_access_rls_results values ('Verified newly enrolled admin has real RLS-backed read/write access');
end $$;
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000002","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000012"}';
do $$ begin
  if private.is_workspace_admin() or public.current_user_role()<>'client'
    or not (public.admin_auth_self_status()->>'requiresVerification')::boolean
    or exists(select 1 from public.clients where id='fa300000-0000-4000-8000-000000000001') then raise exception 'Second unverified session obtained access'; end if;
  insert into admin_access_rls_results values ('Different session for same admin cannot reuse lease and sees no private project data');
end $$;
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000002","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000003"}';
do $$ begin
  if private.is_workspace_admin() or public.admin_auth_self_status()->>'error'<>'unauthorized_session' then raise exception 'Foreign session forged into JWT bypassed ownership check'; end if;
end $$;
reset role;
update private.admin_session_leases set expires_at=now()-interval '1 second' where session_id='fa200000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000002","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000002"}';
do $$ begin
  if private.is_workspace_admin() or exists(select 1 from public.clients where id='fa300000-0000-4000-8000-000000000001') then raise exception 'Expired lease granted access'; end if;
  insert into admin_access_rls_results values ('Expired lease and foreign-session JWT both fail closed in RLS');
end $$;
reset role;
update private.admin_session_leases set expires_at=now()+interval '8 hours' where session_id='fa200000-0000-4000-8000-000000000002';
set local role service_role;
select public.admin_auth_revoke('fa100000-0000-4000-8000-000000000002','fa200000-0000-4000-8000-000000000002');
set local role authenticated;
do $$ begin
  if private.is_workspace_admin() or public.current_user_role()<>'client' then raise exception 'Revoked lease still grants admin'; end if;
  insert into admin_access_rls_results values ('Explicit lease revocation immediately blocks RLS and current_user_role');
end $$;
reset role;
update private.admin_session_leases set revoked_at=null where session_id='fa200000-0000-4000-8000-000000000002';
delete from auth.sessions where id='fa200000-0000-4000-8000-000000000002';
do $$ begin
  if (select count(*) from private.admin_sms_challenges where user_id='fa100000-0000-4000-8000-000000000002')<>2 then raise exception 'Signing out erased send-rate history'; end if;
end $$;
set local role authenticated;
do $$ begin
  if private.is_workspace_admin() or exists(select 1 from public.clients where id='fa300000-0000-4000-8000-000000000001') then raise exception 'Deleted Auth session remains authorized'; end if;
  insert into admin_access_rls_results values ('Deleted Supabase Auth session immediately invalidates previously signed JWT admin access');
end $$;

-- Owner completes enrollment; their other pre-existing session must now require SMS.
set local role service_role;
do $$ declare r jsonb; begin
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001',repeat('a',64),'fa400000-0000-4000-8000-000000000003',repeat('c',64),repeat('d',64));
  if not (r->>'ok')::boolean then raise exception 'Owner enrollment challenge failed: %',r; end if;
  perform public.admin_auth_confirm_delivery('fa400000-0000-4000-8000-000000000003','fixture-owner-code');
  r:=public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','fa400000-0000-4000-8000-000000000003',repeat('c',64));
  if not (r->>'ok')::boolean then raise exception 'Owner enrollment failed: %',r; end if;
end $$;
set local role authenticated;
set local request.jwt.claim.sub='fa100000-0000-4000-8000-000000000001';
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000001","email":"lp-admin-rls-owner@example.invalid","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000011"}';
do $$ begin
  if private.is_workspace_admin() or public.current_user_role()<>'client' then raise exception 'Old allowlist bypassed new owner SMS requirement'; end if;
  insert into admin_access_rls_results values ('Owner enrollment closes legacy bypass on every other session while retaining the same user UUID');
end $$;
reset role;
update private.admin_sms_challenges set created_at=now()-interval '10 minutes' where user_id='fa100000-0000-4000-8000-000000000001';
-- Four additional synthetic attempts plus the owner enrollment fill the hourly cap.
insert into private.admin_sms_challenges(id,user_id,session_id,phone,code_hash,ip_hash,created_at,expires_at,revoked_at)
 select gen_random_uuid(),'fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','+15555550101',repeat('c',64),repeat('d',64),now()-interval '9 minutes',now()-interval '4 minutes',now() from generate_series(1,4);
set local role service_role;
do $$ declare r jsonb; begin
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001',null,'fa400000-0000-4000-8000-000000000099',repeat('c',64),repeat('d',64));
  if r->>'error'<>'rate_limited' or r->>'retryAfterSeconds'<>'3600' then raise exception 'Five-per-hour phone/user limit bypassed: %',r; end if;
  r:=public.admin_auth_create_invite('fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','+15555550102','Phone takeover',null,repeat('e',64));
  if r->>'error'<>'conflict' then raise exception 'Enrolled phone rebound to a new account'; end if;
  insert into admin_access_rls_results values ('Hourly send cap counts failed/expired attempts and enrolled phones cannot be rebound to a different account');
end $$;
reset role;
-- Isolated expired invitation and expired challenge tests never touch real data.
insert into private.admin_invitations(token_hash,phone,display_name,created_by,expires_at,sent_at)
 values(repeat('9',64),'+15555550104','Expired fixture','fa100000-0000-4000-8000-000000000001',now()-interval '1 second',now()-interval '49 hours');
set local role service_role;
do $$ declare r jsonb; begin
  if public.admin_auth_invite_info(repeat('9',64))->>'error'<>'invalid_invite' then raise exception 'Expired invite info accepted'; end if;
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000003','fa200000-0000-4000-8000-000000000003',repeat('9',64),'fa400000-0000-4000-8000-000000000099',repeat('c',64),repeat('0',64));
  if r->>'error'<>'invalid_invite' then raise exception 'Expired invitation started enrollment'; end if;
end $$;
reset role;
insert into private.admin_memberships(user_id,approved_phone,sms_required,enrolled_at)
 values('fa100000-0000-4000-8000-000000000003','+15555550103',true,now());
-- IP pressure from a different subject/phone must still prevent a fresh send.
insert into private.admin_sms_challenges(id,user_id,session_id,phone,code_hash,ip_hash,created_at,expires_at,revoked_at)
 select gen_random_uuid(),'fa100000-0000-4000-8000-000000000001','fa200000-0000-4000-8000-000000000001','+15555550101',repeat('c',64),repeat('0',64),now()-interval '9 minutes',now()-interval '4 minutes',now() from generate_series(1,10);
set local role service_role;
do $$ declare r jsonb; begin
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000003','fa200000-0000-4000-8000-000000000003',null,'fa400000-0000-4000-8000-000000000004',repeat('c',64),repeat('0',64));
  if r->>'error'<>'rate_limited' then raise exception 'Ten-per-hour IP cap bypassed'; end if;
  r:=public.admin_auth_begin_challenge('fa100000-0000-4000-8000-000000000003','fa200000-0000-4000-8000-000000000003',null,'fa400000-0000-4000-8000-000000000004',repeat('c',64),repeat('1',64));
  if not (r->>'ok')::boolean or r->>'phone'<>'+15555550103' then raise exception 'Login did not use membership-approved phone: %',r; end if;
  perform public.admin_auth_confirm_delivery('fa400000-0000-4000-8000-000000000004','fixture-expired-code');
  insert into admin_access_rls_results values ('Cross-subject IP cap blocks excess sends; normal login can only target the membership-approved phone');
end $$;
reset role;
update private.admin_sms_challenges set expires_at=now()-interval '1 second' where id='fa400000-0000-4000-8000-000000000004';
set local role service_role;
do $$ begin
  if public.admin_auth_verify_code('fa100000-0000-4000-8000-000000000003','fa200000-0000-4000-8000-000000000003','fa400000-0000-4000-8000-000000000004',repeat('c',64))->>'error'<>'expired_code' then raise exception 'Expired OTP accepted'; end if;
  insert into admin_access_rls_results values ('Expired invitations and OTPs are unusable even with correct hashes');
end $$;
reset role;
-- A valid lease never overrides membership revocation or Auth session expiry.
insert into private.admin_session_leases(session_id,user_id,expires_at)
 values('fa200000-0000-4000-8000-000000000003','fa100000-0000-4000-8000-000000000003',now()+interval '8 hours');
update private.admin_memberships set active=false where user_id='fa100000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claim.sub='fa100000-0000-4000-8000-000000000003';
set local request.jwt.claims='{"sub":"fa100000-0000-4000-8000-000000000003","role":"authenticated","session_id":"fa200000-0000-4000-8000-000000000003"}';
do $$ begin
  if private.is_workspace_admin() or public.current_user_role()<>'client' then raise exception 'Inactive member with live lease admitted'; end if;
end $$;
reset role;
update private.admin_memberships set active=true where user_id='fa100000-0000-4000-8000-000000000003';
update auth.sessions set not_after=now()-interval '1 second' where id='fa200000-0000-4000-8000-000000000003';
set local role authenticated;
do $$ begin
  if private.is_workspace_admin() then raise exception 'Expired Auth session with live lease admitted'; end if;
  insert into admin_access_rls_results values ('Inactive membership and expired Auth sessions override valid verification leases');
end $$;
reset role;
do $$ declare f record; begin
  for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'admin_auth_%' loop
    if has_function_privilege('anon',f.oid,'EXECUTE') then raise exception 'Anonymous function grant retained: %',f.proname; end if;
    if f.proname<>'admin_auth_self_status' and has_function_privilege('authenticated',f.oid,'EXECUTE') then raise exception 'Browser privileged grant retained: %',f.proname; end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'admin_auth_%' and p.prosecdef) then raise exception 'Exposed SECURITY DEFINER function'; end if;
  insert into admin_access_rls_results values ('No anonymous RPC, privileged authenticated RPC, or public SECURITY DEFINER surface');
end $$;
select check_name from admin_access_rls_results order by check_name;
rollback;
