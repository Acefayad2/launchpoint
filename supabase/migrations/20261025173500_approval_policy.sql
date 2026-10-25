drop policy approvals_admin_update on public.approvals;
drop policy approvals_client_respond on public.approvals;

revoke update on public.approvals from authenticated;
grant update (status, responded_at, responded_by) on public.approvals to authenticated;

create policy approvals_update_authorized on public.approvals
for update to authenticated
using (
  private.is_workspace_admin()
  or (
    status = 'requested'
    and exists (
      select 1 from public.clients c
      where c.id = client_id
        and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    )
  )
)
with check (
  private.is_workspace_admin()
  or (
    status in ('approved', 'changes_requested')
    and responded_by = (select auth.uid())
    and exists (
      select 1 from public.clients c
      where c.id = client_id
        and c.contact_email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
    )
  )
);
