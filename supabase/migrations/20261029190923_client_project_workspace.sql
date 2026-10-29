alter table public.clients
  add column support_status text not null default 'none' check (support_status in ('none', 'active', 'paused', 'canceled')),
  add column support_plan text not null default '' check (char_length(support_plan) <= 160),
  add column stripe_subscription_id text check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  add column subscription_status text not null default 'unlinked',
  add column subscription_checked_at timestamptz,
  add column subscription_access_until timestamptz;
create unique index clients_stripe_subscription_key on public.clients(stripe_subscription_id) where stripe_subscription_id is not null;

-- Browsers may link a subscription, but only the server may attest paid access.
create function private.guard_subscription_cache()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' and (new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.contact_email is distinct from old.contact_email) then
    new.support_status := 'none';
    new.subscription_status := case when new.stripe_subscription_id is null then 'unlinked' else 'unverified' end;
    new.subscription_checked_at := null;
    new.subscription_access_until := null;
  elsif current_user in ('authenticated', 'anon') then
    if TG_OP = 'INSERT' then
      if new.support_status <> 'none' or new.subscription_status <> 'unlinked'
        or new.subscription_checked_at is not null or new.subscription_access_until is not null then
        raise exception 'Subscription verification is server-only' using errcode = '42501';
      end if;
    elsif row(new.support_status,new.subscription_status,new.subscription_checked_at,new.subscription_access_until)
      is distinct from row(old.support_status,old.subscription_status,old.subscription_checked_at,old.subscription_access_until) then
      raise exception 'Subscription verification is server-only' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_subscription_cache() from public, anon, authenticated;
create trigger clients_subscription_cache_guard before insert or update on public.clients
  for each row execute function private.guard_subscription_cache();

create function private.can_submit_project_work(p_client_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select (select auth.uid()) is not null and private.can_access_client(p_client_id)
    and (private.is_workspace_admin() or exists (
      select 1 from public.clients where id = p_client_id
        and (status in ('active', 'waiting') or (support_status = 'active'
          and subscription_checked_at > now() - interval '10 minutes' and subscription_access_until > now()))
    ));
$$;
revoke all on function private.can_submit_project_work(uuid) from public, anon;
grant execute on function private.can_submit_project_work(uuid) to authenticated;

create table public.edit_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null check (char_length(btrim(description)) between 1 and 5000),
  page_url text not null default '' check (page_url = '' or (char_length(page_url) <= 2048 and page_url ~ '^https?://[^[:space:]]+$')),
  status text not null default 'submitted' check (status in ('submitted', 'in_progress', 'needs_info', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id)
);
create index edit_requests_client_created_idx on public.edit_requests(client_id, created_at desc);
create index edit_requests_created_by_idx on public.edit_requests(created_by);
create trigger edit_requests_updated_at before update on public.edit_requests
  for each row execute function private.set_updated_at();
alter table public.edit_requests enable row level security;
revoke all on public.edit_requests from anon, authenticated;
grant select, insert on public.edit_requests to authenticated;
grant update(status) on public.edit_requests to authenticated;
create policy edit_requests_read on public.edit_requests for select to authenticated
  using (private.can_access_client(client_id));
create policy edit_requests_submit on public.edit_requests for insert to authenticated
  with check (created_by = (select auth.uid()) and status = 'submitted' and private.can_submit_project_work(client_id));
create policy edit_requests_manage on public.edit_requests for update to authenticated
  using (private.is_workspace_admin()) with check (private.is_workspace_admin());

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  request_id uuid,
  uploaded_by uuid not null references auth.users(id),
  storage_path text not null unique,
  filename text not null check (char_length(filename) between 1 and 180),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip')),
  size bigint not null check (size between 1 and 10485760),
  created_at timestamptz not null default now(),
  foreign key (request_id, client_id) references public.edit_requests(id, client_id),
  check (storage_path like client_id::text || '/' || uploaded_by::text || '/%')
);
create index project_files_client_created_idx on public.project_files(client_id, created_at desc);
create index project_files_request_client_idx on public.project_files(request_id, client_id);
create index project_files_uploaded_by_idx on public.project_files(uploaded_by);
alter table public.project_files enable row level security;
revoke all on public.project_files from anon, authenticated;
grant select, insert on public.project_files to authenticated;
create policy project_files_read on public.project_files for select to authenticated
  using (private.can_access_client(client_id));
create policy project_files_submit on public.project_files for insert to authenticated
  with check (
    uploaded_by = (select auth.uid()) and private.can_submit_project_work(client_id)
    and exists (select 1 from storage.objects o where o.bucket_id = 'project-files'
      and o.name = storage_path and (o.metadata->>'size')::bigint = size
      and o.metadata->>'mimetype' = mime_type)
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('project-files', 'project-files', false, 10485760,
  array['image/png','image/jpeg','image/webp','application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/zip']);

create function private.project_path_client(p_path text)
returns uuid language sql immutable security invoker set search_path = '' as $$
  select case when p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|jpeg|webp|pdf|txt|docx|zip)$'
    then split_part(p_path, '/', 1)::uuid else null end;
$$;
revoke all on function private.project_path_client(text) from public, anon;
grant execute on function private.project_path_client(text) to authenticated;
create policy project_storage_read on storage.objects for select to authenticated
  using (bucket_id = 'project-files' and private.project_path_client(name) is not null
    and private.can_access_client(private.project_path_client(name)));
create policy project_storage_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'project-files'
    and private.project_path_client(name) is not null
    and split_part(name, '/', 2) = (select auth.uid())::text
    and private.can_submit_project_work(private.project_path_client(name)));
create policy project_storage_cleanup on storage.objects for delete to authenticated
  using (bucket_id = 'project-files' and split_part(name, '/', 2) = (select auth.uid())::text
    and private.project_path_client(name) is not null
    and private.can_access_client(private.project_path_client(name))
    and not exists (select 1 from public.project_files f where f.storage_path = name));

create function public.save_project_workspace(p_client_id uuid, p_project jsonb, p_milestones jsonb)
returns public.clients language plpgsql security invoker set search_path = '' as $$
declare
  result public.clients;
  item jsonb;
  position_index integer := 0;
  complete_count integer := 0;
  subscription_id text := nullif(btrim(p_project->>'stripeSubscriptionId'),'');
begin
  if (select auth.uid()) is null or not private.is_workspace_admin() then
    raise exception 'Admin access required' using errcode = '42501';
  end if;
  if p_milestones is null or jsonb_typeof(p_milestones) <> 'array' or jsonb_array_length(p_milestones) > 12 then
    raise exception 'Use at most 12 milestones';
  end if;
  if p_project is null or jsonb_typeof(p_project) <> 'object'
    or char_length(coalesce(btrim(p_project->>'business'),'')) not between 1 and 120
    or char_length(coalesce(btrim(p_project->>'project'),'')) not between 1 and 160
    or char_length(coalesce(btrim(p_project->>'nextStep'),'')) not between 1 and 160
    or char_length(coalesce(p_project->>'summary','')) > 3000
    or char_length(coalesce(p_project->>'nextCopy','')) > 3000
    or char_length(coalesce(p_project->>'targetDate','')) > 100
    or char_length(coalesce(p_project->>'contact','')) > 120
    or char_length(coalesce(p_project->>'email','')) > 254 then
    raise exception 'Check project details and text lengths';
  end if;
  if coalesce(btrim(p_project->>'email'),'') <> '' and p_project->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid client email';
  end if;
  for item in select value from jsonb_array_elements(p_milestones) loop
    if jsonb_typeof(item) <> 'object' or char_length(coalesce(btrim(item->>'label'),'')) not between 1 and 120
      or coalesce(item->>'state','') not in ('complete','current','upcoming') then
      raise exception 'Check milestone labels and states';
    end if;
    if item->>'state' = 'complete' then complete_count := complete_count + 1; end if;
  end loop;
  update public.clients set
    business = btrim(p_project->>'business'), contact_name = nullif(btrim(p_project->>'contact'),''),
    contact_email = nullif(lower(btrim(p_project->>'email')),''), project = btrim(p_project->>'project'),
    status = p_project->>'status', summary = coalesce(btrim(p_project->>'summary'),''),
    next_step = btrim(p_project->>'nextStep'), next_copy = coalesce(btrim(p_project->>'nextCopy'),''),
    target_date = coalesce(nullif(btrim(p_project->>'targetDate'),''),'Not scheduled'),
    support_plan = coalesce(btrim(p_project->>'supportPlan'),''),
    support_status = case when stripe_subscription_id is distinct from subscription_id or contact_email is distinct from nullif(lower(btrim(p_project->>'email')),'') then 'none' else support_status end,
    subscription_status = case when stripe_subscription_id is distinct from subscription_id or contact_email is distinct from nullif(lower(btrim(p_project->>'email')),'') then 'unverified' else subscription_status end,
    subscription_checked_at = case when stripe_subscription_id is distinct from subscription_id or contact_email is distinct from nullif(lower(btrim(p_project->>'email')),'') then null else subscription_checked_at end,
    subscription_access_until = case when stripe_subscription_id is distinct from subscription_id or contact_email is distinct from nullif(lower(btrim(p_project->>'email')),'') then null else subscription_access_until end,
    stripe_subscription_id = subscription_id,
    progress = case when jsonb_array_length(p_milestones) = 0 then null else round(100.0 * complete_count / jsonb_array_length(p_milestones)) end
  where id = p_client_id returning * into result;
  if result.id is null then raise exception 'Project not found'; end if;
  for item in select value from jsonb_array_elements(p_milestones) loop
    insert into public.milestones(client_id, position, label, state)
      values (p_client_id, position_index, btrim(item->>'label'), item->>'state')
      on conflict(client_id,position) do update set label=excluded.label,state=excluded.state;
    position_index := position_index + 1;
  end loop;
  delete from public.milestones where client_id=p_client_id and position>=position_index;
  return result;
end;
$$;
revoke all on function public.save_project_workspace(uuid,jsonb,jsonb) from public, anon;
grant execute on function public.save_project_workspace(uuid,jsonb,jsonb) to authenticated;

create function public.create_project_workspace(p_project jsonb)
returns public.clients language plpgsql security invoker set search_path = '' as $$
declare result public.clients;
begin
  if (select auth.uid()) is null or not private.is_workspace_admin() then
    raise exception 'Admin access required' using errcode='42501';
  end if;
  insert into public.clients(slug,business,contact_name,contact_email,project,status,next_step,progress)
    values ('project-' || gen_random_uuid()::text,btrim(p_project->>'business'),nullif(btrim(p_project->>'contact'),''),
      nullif(lower(btrim(p_project->>'email')),''),btrim(p_project->>'project'),coalesce(p_project->>'status','active'),
      btrim(p_project->>'nextStep'),0) returning * into result;
  return public.save_project_workspace(result.id,
    jsonb_build_object('business',result.business,'contact',result.contact_name,'email',result.contact_email,
      'project',result.project,'status',result.status,'summary','Your LaunchPoint project is ready to begin.',
      'nextStep',result.next_step,'nextCopy','Your team will share the next steps here.','targetDate','Not scheduled',
      'supportStatus','none','supportPlan',''),
    '[{"label":"Kickoff","state":"current"},{"label":"Direction","state":"upcoming"},{"label":"Build","state":"upcoming"},{"label":"Launch","state":"upcoming"}]'::jsonb);
end;
$$;
revoke all on function public.create_project_workspace(jsonb) from public, anon;
grant execute on function public.create_project_workspace(jsonb) to authenticated;

alter publication supabase_realtime add table public.clients, public.milestones, public.edit_requests, public.project_files;

grant select, update on public.clients to service_role;
