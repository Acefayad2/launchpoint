-- Projects can be listed before a client contact and delivery details are known.
alter table public.clients alter column contact_name drop not null;
alter table public.clients alter column contact_email drop not null;
alter table public.clients alter column progress drop not null;
alter table public.clients drop constraint clients_status_check;
alter table public.clients add constraint clients_status_check
  check (status in ('active', 'waiting', 'complete', 'untracked'));

insert into public.clients (
  slug, business, contact_name, contact_email, project, status, progress,
  next_step, next_copy, project_value, summary
) values
  ('anointed-money-group', 'Anointed Money Group (AMG)', null, null,
   'Website and CRM', 'untracked', null, 'Add project details',
   'Add a contact and current project status to start tracking this work.',
   'Not recorded', 'Project listed in LaunchPoint. Details have not been added yet.'),
  ('hmp', 'HMP', null, null,
   'Portal and website', 'untracked', null, 'Add project details',
   'Add a contact and current project status to start tracking this work.',
   'Not recorded', 'Project listed in LaunchPoint. Details have not been added yet.'),
  ('yardly', 'Yardly', null, null,
   'Marketplace app', 'untracked', null, 'Add project details',
   'Add a contact and current project status to start tracking this work.',
   'Not recorded', 'Project listed in LaunchPoint. Details have not been added yet.')
on conflict (slug) do nothing;
