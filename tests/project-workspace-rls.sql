-- Run this ENTIRE batch as the database owner after the project-workspace migration.
-- It creates synthetic auth/database/storage-metadata rows only inside one transaction.
-- No Auth email, Stripe request, or Storage upload is performed. Do not add COMMIT.
-- Any failed assertion aborts the transaction; close/rollback that transaction if the
-- SQL runner stops before the final ROLLBACK. No pgTAP or optional extension required.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create temporary table project_workspace_rls_results (check_name text primary key) on commit drop;
grant select, insert on project_workspace_rls_results to authenticated, anon;

-- Fixed test identities make every write narrowly scoped and the batch reviewable.
-- Fail on a collision instead of ever changing an existing user or client.
do $$ begin
  if exists (select 1 from auth.users where id in
    ('f1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000003')
    or email in ('lp-rls-admin@example.invalid','lp-rls-client-a@example.invalid','lp-rls-client-b@example.invalid'))
    or exists (select 1 from public.clients where id in
      ('f2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000003')
      or contact_email in ('lp-rls-client-a@example.invalid','lp-rls-client-b@example.invalid','lp-rls-client-a-updated@example.invalid','lp-rls-forged@example.invalid')
      or slug in ('lp-rls-client-a','lp-rls-client-b','lp-rls-forged'))
    or exists (select 1 from private.workspace_admins where email='lp-rls-admin@example.invalid') then
    raise exception 'RLS fixture collision: stop and choose fresh test identifiers; do not overwrite rows';
  end if;
end $$;

insert into auth.users (id,email,aud,role,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values
  ('f1000000-0000-4000-8000-000000000001','lp-rls-admin@example.invalid','authenticated','authenticated',now(),now(),now(),'{}','{}'),
  ('f1000000-0000-4000-8000-000000000002','lp-rls-client-a@example.invalid','authenticated','authenticated',now(),now(),now(),'{}','{}'),
  ('f1000000-0000-4000-8000-000000000003','lp-rls-client-b@example.invalid','authenticated','authenticated',now(),now(),now(),'{}','{}');
insert into private.workspace_admins(email) values ('lp-rls-admin@example.invalid');
insert into private.admin_memberships(user_id,sms_required) values ('f1000000-0000-4000-8000-000000000001',false);
insert into auth.sessions(id,user_id,created_at,updated_at) values
  ('f7000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001',now(),now());
insert into public.clients(id,slug,business,contact_name,contact_email,project,status,next_step) values
  ('f2000000-0000-4000-8000-000000000001','lp-rls-client-a','RLS fixture A','Fixture A','lp-rls-client-a@example.invalid','RLS build A','active','Review fixture'),
  ('f2000000-0000-4000-8000-000000000002','lp-rls-client-b','RLS fixture B','Fixture B','lp-rls-client-b@example.invalid','RLS build B','active','Review fixture');
insert into public.edit_requests(id,client_id,created_by,title,description) values
  ('f3000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','Fixture A request','Private A feedback'),
  ('f3000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000003','Fixture B request','Private B feedback');
insert into storage.objects(id,bucket_id,name,metadata) values
  ('f4000000-0000-4000-8000-000000000001','project-files','f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000001.pdf','{"size":123,"mimetype":"application/pdf"}'),
  ('f4000000-0000-4000-8000-000000000002','project-files','f2000000-0000-4000-8000-000000000002/f1000000-0000-4000-8000-000000000003/f4000000-0000-4000-8000-000000000002.pdf','{"size":123,"mimetype":"application/pdf"}'),
  ('f4000000-0000-4000-8000-000000000003','project-files','f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000003.pdf','{"size":123,"mimetype":"application/pdf"}'),
  ('f4000000-0000-4000-8000-000000000009','project-files','f2000000-0000-4000-8000-000000000002/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000009.pdf','{"size":123,"mimetype":"application/pdf"}');
insert into public.project_files(id,client_id,request_id,uploaded_by,storage_path,filename,mime_type,size) values
  ('f5000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000001.pdf','fixture-a.pdf','application/pdf',123),
  ('f5000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000002','f3000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000003','f2000000-0000-4000-8000-000000000002/f1000000-0000-4000-8000-000000000003/f4000000-0000-4000-8000-000000000002.pdf','fixture-b.pdf','application/pdf',123);

set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-4000-8000-000000000002';
set local request.jwt.claim.email = 'lp-rls-client-a@example.invalid';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000002","email":"lp-rls-client-a@example.invalid","role":"authenticated","user_metadata":{"role":"admin"}}';

do $$ declare changed integer; begin
  if current_user <> 'authenticated' or auth.uid() <> 'f1000000-0000-4000-8000-000000000002'::uuid
    or private.is_workspace_admin() then raise exception 'Client identity or user_metadata isolation failed'; end if;
  insert into project_workspace_rls_results values ('client identity uses real role, not editable user_metadata');
  if (select count(*) from public.clients where id='f2000000-0000-4000-8000-000000000001') <> 1
    or (select count(*) from public.edit_requests where id='f3000000-0000-4000-8000-000000000001') <> 1
    or (select count(*) from public.project_files where id='f5000000-0000-4000-8000-000000000001') <> 1
    or (select count(*) from storage.objects where id='f4000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'Client cannot read its own project, request, file, or storage metadata'; end if;
  insert into project_workspace_rls_results values ('owner reads its own project, requests, files, and storage metadata');
  if exists(select 1 from public.clients where id='f2000000-0000-4000-8000-000000000002')
    or exists(select 1 from public.edit_requests where id='f3000000-0000-4000-8000-000000000002')
    or exists(select 1 from public.project_files where id='f5000000-0000-4000-8000-000000000002')
    or exists(select 1 from storage.objects where id='f4000000-0000-4000-8000-000000000002') then
    raise exception 'Cross-client data visible'; end if;
  insert into project_workspace_rls_results values ('cross-client project, request, file, and storage reads are invisible');

  begin
    insert into public.edit_requests(client_id,created_by,title,description) values
      ('f2000000-0000-4000-8000-000000000002',auth.uid(),'Cross-client write','Must not be accepted');
    raise exception 'Cross-client edit insertion unexpectedly succeeded';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.edit_requests(client_id,created_by,title,description) values
      ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003','Spoofed author','Must not be accepted');
    raise exception 'Spoofed author unexpectedly accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.edit_requests(client_id,created_by,title,description,status) values
      ('f2000000-0000-4000-8000-000000000001',auth.uid(),'Spoofed status','Must not be accepted','completed');
    raise exception 'Client-supplied completed status unexpectedly accepted';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('cross-client edits, spoofed authors, and client-selected statuses are denied');
  begin
    insert into public.project_files(client_id,request_id,uploaded_by,storage_path,filename,mime_type,size) values
      ('f2000000-0000-4000-8000-000000000002','f3000000-0000-4000-8000-000000000002',auth.uid(),'f2000000-0000-4000-8000-000000000002/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000009.pdf','cross-client.pdf','application/pdf',123);
    raise exception 'Cross-client shared-file insert accepted';
  exception when insufficient_privilege then null; end;
  if exists(select 1 from storage.objects where id='f4000000-0000-4000-8000-000000000009') then
    raise exception 'Uploader folder bypassed project ownership'; end if;
  insert into project_workspace_rls_results values ('cross-client shared-file insert and uploader-folder ownership bypass are denied');

  update public.edit_requests set status='completed' where id='f3000000-0000-4000-8000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 or (select status from public.edit_requests where id='f3000000-0000-4000-8000-000000000001') <> 'submitted' then
    raise exception 'Client changed request status'; end if;
  update public.clients set support_status='active',subscription_status='active',subscription_checked_at=now(),subscription_access_until=now()+interval '30 days'
    where id='f2000000-0000-4000-8000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 0 or (select support_status from public.clients where id='f2000000-0000-4000-8000-000000000001') <> 'none' then
    raise exception 'Client forged paid access'; end if;
  insert into project_workspace_rls_results values ('client status and subscription-cache updates match zero rows and preserve originals');
  begin
    perform public.save_project_workspace('f2000000-0000-4000-8000-000000000001','{}','[]');
    raise exception 'Client invoked admin project save';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('client cannot invoke admin project save RPC');

  insert into public.edit_requests(id,client_id,created_by,title,description) values
    ('f3000000-0000-4000-8000-000000000003','f2000000-0000-4000-8000-000000000001',auth.uid(),'Build-stage edit','Allowed while building');
  if not exists(select 1 from public.edit_requests where id='f3000000-0000-4000-8000-000000000003') then raise exception 'Build-stage insert did not persist'; end if;
  insert into storage.objects(id,bucket_id,name,metadata) values
    ('f4000000-0000-4000-8000-000000000004','project-files','f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000004.pdf','{"size":123,"mimetype":"application/pdf"}');
  insert into public.project_files(id,client_id,request_id,uploaded_by,storage_path,filename,mime_type,size) values
    ('f5000000-0000-4000-8000-000000000004','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003',auth.uid(),'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000004.pdf','allowed-build.pdf','application/pdf',123);
  if not exists(select 1 from public.project_files where id='f5000000-0000-4000-8000-000000000004') then raise exception 'Build-stage file did not persist'; end if;
  insert into project_workspace_rls_results values ('build-stage edits and matching private file metadata are allowed');

  begin
    insert into public.project_files(client_id,request_id,uploaded_by,storage_path,filename,mime_type,size) values
      ('f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000002',auth.uid(),'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000003.pdf','cross-request.pdf','application/pdf',123);
    raise exception 'Attachment linked to a request belonging to another client';
  exception when foreign_key_violation then null; end;
  insert into project_workspace_rls_results values ('composite foreign key rejects attachment-to-another-client request');
  begin
    insert into public.project_files(client_id,uploaded_by,storage_path,filename,mime_type,size) values
      ('f2000000-0000-4000-8000-000000000001',auth.uid(),'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000003.pdf','wrong-size.pdf','application/pdf',124);
    raise exception 'Forged object metadata was accepted';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('file record must match stored size and MIME metadata');
  -- Hosted Storage can reject every direct SQL DELETE through protect_delete,
  -- before RLS evaluates rows. Accept that platform denial without disabling it.
  -- This proves the attached object survives a SQL attempt; it does NOT establish
  -- Storage API deletion behavior, which needs a separate API-level check.
  changed := 0;
  begin
    delete from storage.objects where id='f4000000-0000-4000-8000-000000000001';
    get diagnostics changed = row_count;
  exception when insufficient_privilege then null; end;
  if changed <> 0 or not exists(select 1 from storage.objects where id='f4000000-0000-4000-8000-000000000001') then
    raise exception 'Attached object could be removed through cleanup policy'; end if;
  insert into project_workspace_rls_results values ('attached object survives SQL cleanup attempt (platform protection or RLS, not an API deletion test)');
end $$;

do $$ declare invalid_path text; begin
  foreach invalid_path in array array[
    'not-a-project/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000005.pdf',
    'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/../secret.pdf',
    'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/extra/f4000000-0000-4000-8000-000000000005.pdf',
    'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000005.html',
    'f2000000-0000-4000-8000-000000000002/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000005.pdf',
    'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000003/f4000000-0000-4000-8000-000000000005.pdf'
  ] loop
    begin
      insert into storage.objects(id,bucket_id,name,metadata) values ('f4000000-0000-4000-8000-000000000005','project-files',invalid_path,'{"size":123,"mimetype":"application/pdf"}');
      raise exception 'Invalid or unauthorized storage path accepted: %',invalid_path;
    exception when insufficient_privilege then null; end;
  end loop;
  insert into project_workspace_rls_results values ('malformed paths, traversal, extra folders, executable extensions, cross-client and spoofed-owner uploads denied');
end $$;

-- The server role changes ONLY the synthetic A project's billing facts between cases.
set local role service_role;
update public.clients set status='complete' where id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  if private.can_submit_project_work('f2000000-0000-4000-8000-000000000001') then raise exception 'Completed unpaid project still accepts work'; end if;
  begin
    insert into public.edit_requests(client_id,created_by,title,description) values ('f2000000-0000-4000-8000-000000000001',auth.uid(),'Unpaid edit','Must be denied');
    raise exception 'Unpaid post-launch edit accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into storage.objects(id,bucket_id,name,metadata) values ('f4000000-0000-4000-8000-000000000006','project-files','f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000006.pdf','{"size":123,"mimetype":"application/pdf"}');
    raise exception 'Unpaid post-launch upload accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.project_files(client_id,uploaded_by,storage_path,filename,mime_type,size) values
      ('f2000000-0000-4000-8000-000000000001',auth.uid(),'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000003.pdf','old-upload-new-attachment.pdf','application/pdf',123);
    raise exception 'Unpaid completed project attached a previously uploaded object';
  exception when insufficient_privilege then null; end;
  insert into public.messages(id,client_id,sender_id,sender_role,sender_name,body) values
    ('f6000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001',auth.uid(),'client','Fixture A','Post-launch support question');
  if not exists(select 1 from public.messages where id='f6000000-0000-4000-8000-000000000001')
    or not exists(select 1 from public.edit_requests where id='f3000000-0000-4000-8000-000000000001') then
    raise exception 'Closed edit access incorrectly blocks messaging or history'; end if;
  insert into project_workspace_rls_results values ('completed unpaid projects deny edits/uploads while keeping history and messaging');
end $$;

set local role service_role;
update public.clients set stripe_subscription_id='sub_RlsFixtureA' where id='f2000000-0000-4000-8000-000000000001';
update public.clients set support_status='active',subscription_status='active',subscription_checked_at=now(),subscription_access_until=now()+interval '30 days'
  where id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  if not private.can_submit_project_work('f2000000-0000-4000-8000-000000000001') then raise exception 'Verified paid support failed to open edits'; end if;
  insert into public.edit_requests(id,client_id,created_by,title,description) values
    ('f3000000-0000-4000-8000-000000000004','f2000000-0000-4000-8000-000000000001',auth.uid(),'Paid support edit','Allowed after verified payment');
  insert into storage.objects(id,bucket_id,name,metadata) values
    ('f4000000-0000-4000-8000-000000000007','project-files','f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000007.pdf','{"size":123,"mimetype":"application/pdf"}');
  insert into public.project_files(id,client_id,uploaded_by,storage_path,filename,mime_type,size) values
    ('f5000000-0000-4000-8000-000000000007','f2000000-0000-4000-8000-000000000001',auth.uid(),'f2000000-0000-4000-8000-000000000001/f1000000-0000-4000-8000-000000000002/f4000000-0000-4000-8000-000000000007.pdf','paid-support.pdf','application/pdf',123);
  if not exists(select 1 from public.edit_requests where id='f3000000-0000-4000-8000-000000000004')
    or not exists(select 1 from public.project_files where id='f5000000-0000-4000-8000-000000000007') then raise exception 'Paid-support writes did not persist'; end if;
  insert into project_workspace_rls_results values ('fresh verified paid support permits post-launch edits and file uploads');
end $$;

set local role service_role;
update public.clients set support_status='canceled',subscription_status='canceled' where id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  if private.can_submit_project_work('f2000000-0000-4000-8000-000000000001') then raise exception 'Canceled support grants access'; end if;
  begin
    insert into public.edit_requests(client_id,created_by,title,description) values ('f2000000-0000-4000-8000-000000000001',auth.uid(),'Canceled edit','Must be denied');
    raise exception 'Canceled subscription edit accepted';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('canceled subscription denies new edits despite a future former paid-through date');
end $$;
set local role service_role;
update public.clients set support_status='active',subscription_status='active',subscription_access_until=now()-interval '1 minute',subscription_checked_at=now()
  where id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  if private.can_submit_project_work('f2000000-0000-4000-8000-000000000001') then raise exception 'Expired paid period grants access'; end if;
  begin
    insert into public.edit_requests(client_id,created_by,title,description) values ('f2000000-0000-4000-8000-000000000001',auth.uid(),'Expired edit','Must be denied');
    raise exception 'Expired subscription edit accepted';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('expired paid-through period denies new edits even with a fresh active status');
end $$;
set local role service_role;
update public.clients set subscription_access_until=now()+interval '30 days',subscription_checked_at=now()-interval '11 minutes'
  where id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  if private.can_submit_project_work('f2000000-0000-4000-8000-000000000001') then raise exception 'Stale subscription verification grants access'; end if;
  begin
    insert into public.edit_requests(client_id,created_by,title,description) values ('f2000000-0000-4000-8000-000000000001',auth.uid(),'Stale verification edit','Must be denied');
    raise exception 'Stale subscription cache accepted';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('stale verification fails closed until the server rechecks payment status');
end $$;

-- Authenticated admin may manage work, but cannot impersonate the billing server.
set local request.jwt.claim.sub = 'f1000000-0000-4000-8000-000000000001';
set local request.jwt.claim.email = 'lp-rls-admin@example.invalid';
set local request.jwt.claims = '{"sub":"f1000000-0000-4000-8000-000000000001","email":"lp-rls-admin@example.invalid","role":"authenticated","session_id":"f7000000-0000-4000-8000-000000000001"}';
do $$ declare changed integer; begin
  if not private.is_workspace_admin() then raise exception 'Admin fixture not recognized'; end if;
  if (select count(*) from public.clients where id in ('f2000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000002')) <> 2 then
    raise exception 'Admin cannot see both fixture projects'; end if;
  update public.edit_requests set status='in_progress' where id='f3000000-0000-4000-8000-000000000001';
  get diagnostics changed = row_count;
  if changed <> 1 or (select status from public.edit_requests where id='f3000000-0000-4000-8000-000000000001') <> 'in_progress' then
    raise exception 'Admin request status update failed'; end if;
  insert into project_workspace_rls_results values ('authenticated admin sees projects and can update edit-request status');
  begin
    update public.clients set subscription_checked_at=now(),subscription_access_until=now()+interval '365 days'
      where id='f2000000-0000-4000-8000-000000000001';
    raise exception 'Authenticated admin forged subscription verification';
  exception when insufficient_privilege then null; end;
  if (select subscription_checked_at from public.clients where id='f2000000-0000-4000-8000-000000000001') <> now()-interval '11 minutes' then
    raise exception 'Rejected cache update changed the original row'; end if;
  begin
    insert into public.clients(id,slug,business,contact_name,contact_email,project,status,next_step,support_status,subscription_status,subscription_checked_at,subscription_access_until)
    values ('f2000000-0000-4000-8000-000000000003','lp-rls-forged','Forged fixture','Forged','lp-rls-forged@example.invalid','Forged','complete','None','active','active',now(),now()+interval '30 days');
    raise exception 'Authenticated admin inserted a forged paid-access cache';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('authenticated admin cannot update or insert verified billing cache');
  begin
    insert into storage.objects(id,bucket_id,name,metadata) values
      ('f4000000-0000-4000-8000-000000000008','project-files','not-a-client/f1000000-0000-4000-8000-000000000001/f4000000-0000-4000-8000-000000000008.pdf','{"size":123,"mimetype":"application/pdf"}');
    raise exception 'Admin bypassed malformed storage-path validation';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('even authenticated admins must use a well-formed project storage path');

  update public.clients set stripe_subscription_id='sub_RlsFixtureChanged' where id='f2000000-0000-4000-8000-000000000001';
  if not exists(select 1 from public.clients where id='f2000000-0000-4000-8000-000000000001' and support_status='none'
    and subscription_status='unverified' and subscription_checked_at is null and subscription_access_until is null) then
    raise exception 'Changing linked subscription failed to clear verification'; end if;
  insert into project_workspace_rls_results values ('linking a different subscription clears every paid-access cache field');
end $$;
set local role service_role;
update public.clients set support_status='active',subscription_status='active',subscription_checked_at=now(),subscription_access_until=now()+interval '30 days'
  where id='f2000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ declare saved public.clients; begin
  update public.clients set contact_email='lp-rls-client-a-updated@example.invalid' where id='f2000000-0000-4000-8000-000000000001';
  if not exists(select 1 from public.clients where id='f2000000-0000-4000-8000-000000000001' and support_status='none'
    and subscription_status='unverified' and subscription_checked_at is null and subscription_access_until is null) then
    raise exception 'Changing client email failed to clear verification'; end if;
  insert into project_workspace_rls_results values ('changing client email clears verified subscription ownership');
  select * into saved from public.save_project_workspace('f2000000-0000-4000-8000-000000000001',
    '{"business":"RLS fixture A","contact":"Fixture A","email":"lp-rls-client-a-updated@example.invalid","project":"RLS build A","status":"complete","nextStep":"Review fixture","stripeSubscriptionId":"sub_RlsFixtureChanged","supportStatus":"active","subscriptionStatus":"active"}',
    '[{"label":"First milestone","state":"complete"},{"label":"Second milestone","state":"upcoming"}]');
  if saved.id <> 'f2000000-0000-4000-8000-000000000001'::uuid or saved.progress <> 50 or saved.support_status <> 'none'
    or saved.subscription_checked_at is not null or saved.subscription_access_until is not null then
    raise exception 'Admin project RPC did not save real progress safely'; end if;
  insert into project_workspace_rls_results values ('admin project RPC computes real milestone progress and ignores forged billing fields');
end $$;

set local role anon;
set local request.jwt.claim.sub = '';
set local request.jwt.claim.email = '';
set local request.jwt.claim.role = 'anon';
set local request.jwt.claims = '{}';
do $$ begin
  begin
    perform 1 from public.edit_requests where id='f3000000-0000-4000-8000-000000000001';
    raise exception 'Anonymous request read unexpectedly has a table grant';
  exception when insufficient_privilege then null; end;
  begin
    perform 1 from public.project_files where id='f5000000-0000-4000-8000-000000000001';
    raise exception 'Anonymous file read unexpectedly has a table grant';
  exception when insufficient_privilege then null; end;
  insert into project_workspace_rls_results values ('anonymous readers have no edit-request or shared-file table access');
end $$;

reset role;
-- A single compact row is returned before every fixture and grant is rolled back.
select jsonb_build_object('passed',count(*),'checks',jsonb_agg(check_name order by check_name),'rollback_follows',true) as project_workspace_rls_verification
from project_workspace_rls_results;
rollback;
