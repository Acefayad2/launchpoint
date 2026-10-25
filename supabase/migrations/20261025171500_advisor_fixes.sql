create policy workspace_admins_read_self on private.workspace_admins
for select to authenticated
using (email = lower(coalesce((select auth.jwt()) ->> 'email', '')));

create index messages_sender_id_idx on public.messages (sender_id);
create index approvals_responded_by_idx on public.approvals (responded_by);

create policy messages_mark_read on public.messages
for update to authenticated
using (
  private.can_access_client(client_id)
  and (
    (private.is_workspace_admin() and sender_role = 'client')
    or (not private.is_workspace_admin() and sender_role = 'admin')
  )
)
with check (
  private.can_access_client(client_id)
  and (
    (private.is_workspace_admin() and sender_role = 'client')
    or (not private.is_workspace_admin() and sender_role = 'admin')
  )
);

grant update (read_by_admin_at, read_by_client_at) on public.messages to authenticated;

create policy approvals_client_respond on public.approvals
for update to authenticated
using (
  status = 'requested'
  and exists (
    select 1 from public.clients c
    where c.id = client_id
      and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  )
)
with check (
  status in ('approved', 'changes_requested')
  and responded_by = (select auth.uid())
  and exists (
    select 1 from public.clients c
    where c.id = client_id
      and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
  )
);

grant update (status, responded_at, responded_by) on public.approvals to authenticated;

alter function public.mark_messages_read(uuid) security invoker;
alter function public.respond_to_approval(uuid, text) security invoker;
