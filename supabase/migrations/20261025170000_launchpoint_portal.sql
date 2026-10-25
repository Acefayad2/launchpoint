create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table private.workspace_admins (
  email text primary key,
  created_at timestamptz not null default now(),
  constraint workspace_admin_email_normalized check (email = lower(email))
);

insert into private.workspace_admins (email)
values ('hello@mylaunch.dev')
on conflict (email) do nothing;

alter table private.workspace_admins enable row level security;

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  business text not null,
  contact_name text not null,
  contact_email text not null,
  project text not null,
  status text not null default 'active' check (status in ('active', 'waiting', 'complete')),
  progress integer not null default 10 check (progress between 0 and 100),
  next_step text not null,
  next_copy text not null default 'Your LaunchPoint team will add the details for this step shortly.',
  target_date text not null default 'Set date',
  project_value text not null default 'Scope pending',
  summary text not null default 'Your LaunchPoint project is ready to begin.',
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_email_normalized check (contact_email = lower(contact_email)),
  constraint client_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create unique index clients_contact_email_key on public.clients (lower(contact_email));

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  position smallint not null check (position >= 0),
  label text not null,
  state text not null default 'upcoming' check (state in ('complete', 'current', 'upcoming')),
  created_at timestamptz not null default now(),
  unique (client_id, position)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete restrict,
  sender_role text not null check (sender_role in ('admin', 'client')),
  sender_name text not null,
  body text not null check (char_length(body) between 1 and 1200),
  read_by_admin_at timestamptz,
  read_by_client_at timestamptz,
  created_at timestamptz not null default now()
);

create index messages_client_created_idx on public.messages (client_id, created_at);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  label text not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'changes_requested')),
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  responded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index approvals_client_status_idx on public.approvals (client_id, status);

create or replace function private.is_workspace_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from private.workspace_admins a
      where a.email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    );
$$;

revoke all on function private.is_workspace_admin() from public, anon;
grant execute on function private.is_workspace_admin() to authenticated;

create or replace function private.can_access_client(requested_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and (
      private.is_workspace_admin()
      or exists (
        select 1
        from public.clients c
        where c.id = requested_client_id
          and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
      )
    );
$$;

revoke all on function private.can_access_client(uuid) from public, anon;
grant execute on function private.can_access_client(uuid) to authenticated;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger clients_set_updated_at
before update on public.clients
for each row execute function private.set_updated_at();

alter table public.clients enable row level security;
alter table public.milestones enable row level security;
alter table public.messages enable row level security;
alter table public.approvals enable row level security;

create policy clients_select_accessible on public.clients
for select to authenticated
using (private.can_access_client(id));

create policy clients_admin_insert on public.clients
for insert to authenticated
with check (private.is_workspace_admin());

create policy clients_admin_update on public.clients
for update to authenticated
using (private.is_workspace_admin())
with check (private.is_workspace_admin());

create policy clients_admin_delete on public.clients
for delete to authenticated
using (private.is_workspace_admin());

create policy milestones_select_accessible on public.milestones
for select to authenticated
using (private.can_access_client(client_id));

create policy milestones_admin_insert on public.milestones
for insert to authenticated
with check (private.is_workspace_admin());

create policy milestones_admin_update on public.milestones
for update to authenticated
using (private.is_workspace_admin())
with check (private.is_workspace_admin());

create policy milestones_admin_delete on public.milestones
for delete to authenticated
using (private.is_workspace_admin());

create policy messages_select_accessible on public.messages
for select to authenticated
using (private.can_access_client(client_id));

create policy messages_insert_as_self on public.messages
for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and (
    (sender_role = 'admin' and private.is_workspace_admin())
    or (
      sender_role = 'client'
      and exists (
        select 1 from public.clients c
        where c.id = client_id
          and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
      )
    )
  )
);

create policy approvals_select_accessible on public.approvals
for select to authenticated
using (private.can_access_client(client_id));

create policy approvals_admin_insert on public.approvals
for insert to authenticated
with check (private.is_workspace_admin());

create policy approvals_admin_update on public.approvals
for update to authenticated
using (private.is_workspace_admin())
with check (private.is_workspace_admin());

create policy approvals_admin_delete on public.approvals
for delete to authenticated
using (private.is_workspace_admin());

revoke all on public.clients, public.milestones, public.messages, public.approvals from anon, authenticated;
grant select, insert, update, delete on public.clients, public.milestones, public.approvals to authenticated;
grant select, insert on public.messages to authenticated;

create or replace function public.mark_messages_read(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not private.can_access_client(p_client_id) then
    raise exception 'Not authorized';
  end if;

  if private.is_workspace_admin() then
    update public.messages
      set read_by_admin_at = coalesce(read_by_admin_at, now())
      where client_id = p_client_id and sender_role = 'client';
  else
    update public.messages
      set read_by_client_at = coalesce(read_by_client_at, now())
      where client_id = p_client_id and sender_role = 'admin';
  end if;
end;
$$;

revoke all on function public.mark_messages_read(uuid) from public, anon;
grant execute on function public.mark_messages_read(uuid) to authenticated;

create or replace function public.respond_to_approval(p_approval_id uuid, p_status text)
returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  result public.approvals;
begin
  if (select auth.uid()) is null or p_status not in ('approved', 'changes_requested') then
    raise exception 'Invalid approval response';
  end if;

  update public.approvals a
  set status = p_status,
      responded_at = now(),
      responded_by = (select auth.uid())
  where a.id = p_approval_id
    and a.status = 'requested'
    and exists (
      select 1 from public.clients c
      where c.id = a.client_id
        and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    )
  returning a.* into result;

  if result.id is null then
    raise exception 'Approval not found or not authorized';
  end if;
  return result;
end;
$$;

revoke all on function public.respond_to_approval(uuid, text) from public, anon;
grant execute on function public.respond_to_approval(uuid, text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'approvals'
  ) then
    alter publication supabase_realtime add table public.approvals;
  end if;
end $$;

insert into public.clients (
  id, slug, business, contact_name, contact_email, project, status, progress,
  next_step, next_copy, target_date, project_value, summary
) values (
  '11111111-1111-4111-8111-111111111111',
  'launchpoint-demo',
  'LaunchPoint Demo',
  'Jacob Fayad',
  'hello@mylaunch.dev',
  'Client portal launch',
  'waiting',
  75,
  'Approve the secure portal',
  'Review the authenticated portal, shared messaging, and approval workflow.',
  'Ready for review',
  'Internal',
  'This demo project lets you test the same secure experience your clients receive.'
) on conflict (id) do nothing;

insert into public.milestones (client_id, position, label, state) values
  ('11111111-1111-4111-8111-111111111111', 0, 'Dashboard design', 'complete'),
  ('11111111-1111-4111-8111-111111111111', 1, 'Database & security', 'complete'),
  ('11111111-1111-4111-8111-111111111111', 2, 'Client approval', 'current'),
  ('11111111-1111-4111-8111-111111111111', 3, 'Production launch', 'upcoming')
on conflict (client_id, position) do nothing;

insert into public.approvals (id, client_id, label, status) values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  'secure portal',
  'requested'
) on conflict (id) do nothing;
