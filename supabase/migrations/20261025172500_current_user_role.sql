grant select on private.workspace_admins to authenticated;

create or replace function public.current_user_role()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when exists (select 1 from private.workspace_admins) then 'admin'
    else 'client'
  end;
$$;

revoke all on function public.current_user_role() from public, anon;
grant execute on function public.current_user_role() to authenticated;
