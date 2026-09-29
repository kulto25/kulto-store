-- Run this once in Supabase: Project -> SQL Editor -> New query -> paste -> Run.
-- It creates the single table Kulto uses to store the catalog, orders and settings.

create table if not exists kulto_kv (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

-- Row Level Security: this makes the table reachable with the public "anon" key,
-- which is what the website uses in the browser. There is no login system yet,
-- so anyone who has your site's anon key (visible in the browser) could in theory
-- write to this table directly, not just through the site. For a store that's
-- just starting out this is a reasonable trade-off, but if Kulto grows, the next
-- security step is to add Supabase Auth and restrict writes to a logged-in admin.
alter table kulto_kv enable row level security;

create policy "public read" on kulto_kv
  for select using (true);

create policy "public write" on kulto_kv
  for insert with check (true);

create policy "public update" on kulto_kv
  for update using (true);

create policy "public delete" on kulto_kv
  for delete using (true);
