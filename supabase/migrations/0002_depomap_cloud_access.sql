-- DepoMap cloud access baseline.
-- Apply this after the initial schema. This script replaces RLS policies on
-- DepoMap tables listed below, but does not delete application data.

create or replace function public.depomap_has_org_role(
  p_organization_id uuid,
  p_allowed_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.role::text = any (p_allowed_roles)
  );
$$;

create or replace function public.depomap_is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.depomap_has_org_role(
    p_organization_id,
    array['owner', 'manager', 'worker', 'viewer']::text[]
  );
$$;

create or replace function public.depomap_can_edit_org(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.depomap_has_org_role(
    p_organization_id,
    array['owner', 'manager', 'worker']::text[]
  );
$$;

revoke all on function public.depomap_has_org_role(uuid, text[]) from public;
revoke all on function public.depomap_is_org_member(uuid) from public;
revoke all on function public.depomap_can_edit_org(uuid) from public;
grant execute on function public.depomap_has_org_role(uuid, text[]) to authenticated;
grant execute on function public.depomap_is_org_member(uuid) to authenticated;
grant execute on function public.depomap_can_edit_org(uuid) to authenticated;

-- First login: create one organization, owner membership and default warehouse.
-- Existing users without a warehouse receive one in their existing organization.
create or replace function public.depomap_create_organization(
  p_organization_name text,
  p_warehouse_name text,
  p_width_m numeric default 12,
  p_length_m numeric default 8,
  p_grid_size_m numeric default 0.5
)
returns table (organization_id uuid, warehouse_id uuid)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := auth.uid();
  v_organization_id uuid;
  v_warehouse_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_width_m <= 0 or p_length_m <= 0 or p_grid_size_m <= 0 then
    raise exception 'Warehouse dimensions and grid size must be positive';
  end if;

  select m.organization_id
    into v_organization_id
  from public.memberships m
  where m.user_id = v_user_id
  order by m.joined_at asc
  limit 1;

  if v_organization_id is null then
    insert into public.organizations (name, created_by)
    values (coalesce(nullif(trim(p_organization_name), ''), 'DepoMap Organizasyonu'), v_user_id)
    returning id into v_organization_id;

    insert into public.memberships (organization_id, user_id, role)
    values (v_organization_id, v_user_id, 'owner');
  end if;

  select w.id
    into v_warehouse_id
  from public.warehouses w
  where w.organization_id = v_organization_id
  order by w.created_at asc
  limit 1;

  if v_warehouse_id is null then
    insert into public.warehouses (organization_id, name, width_m, length_m, grid_size_m)
    values (
      v_organization_id,
      coalesce(nullif(trim(p_warehouse_name), ''), 'Ana Depo'),
      p_width_m,
      p_length_m,
      p_grid_size_m
    )
    returning id into v_warehouse_id;
  end if;

  return query select v_organization_id, v_warehouse_id;
end;
$$;

revoke all on function public.depomap_create_organization(text, text, numeric, numeric, numeric) from public;
grant execute on function public.depomap_create_organization(text, text, numeric, numeric, numeric) to authenticated;

-- Remove previous policies on these tables so old permissive rules cannot
-- accidentally override this membership-based access model.
do $$
declare
  policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'organizations', 'memberships', 'warehouses', 'map_objects',
        'storage_units', 'products', 'storage_contents',
        'inventory_movements', 'audit_logs'
      ])
  loop
    execute format('drop policy if exists %I on %I.%I', policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  end loop;
end;
$$;

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.warehouses enable row level security;
alter table public.map_objects enable row level security;
alter table public.storage_units enable row level security;
alter table public.products enable row level security;
alter table public.storage_contents enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.audit_logs enable row level security;

-- Organizations and memberships are readable only inside the signed-in user's org.
create policy depomap_organizations_read on public.organizations
for select to authenticated
using (public.depomap_is_org_member(id));

create policy depomap_organizations_update on public.organizations
for update to authenticated
using (public.depomap_has_org_role(id, array['owner']::text[]))
with check (public.depomap_has_org_role(id, array['owner']::text[]));

create policy depomap_organizations_delete on public.organizations
for delete to authenticated
using (public.depomap_has_org_role(id, array['owner']::text[]));

create policy depomap_memberships_read on public.memberships
for select to authenticated
using (user_id = auth.uid() or public.depomap_is_org_member(organization_id));

-- Warehouse map and inventory reads are available to every organization member.
create policy depomap_warehouses_read on public.warehouses
for select to authenticated
using (public.depomap_is_org_member(organization_id));
create policy depomap_warehouses_insert on public.warehouses
for insert to authenticated
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_warehouses_update on public.warehouses
for update to authenticated
using (public.depomap_can_edit_org(organization_id))
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_warehouses_delete on public.warehouses
for delete to authenticated
using (public.depomap_has_org_role(organization_id, array['owner', 'manager']::text[]));

create policy depomap_map_objects_read on public.map_objects
for select to authenticated
using (public.depomap_is_org_member(organization_id));
create policy depomap_map_objects_insert on public.map_objects
for insert to authenticated
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_map_objects_update on public.map_objects
for update to authenticated
using (public.depomap_can_edit_org(organization_id))
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_map_objects_delete on public.map_objects
for delete to authenticated
using (public.depomap_can_edit_org(organization_id));

create policy depomap_storage_units_read on public.storage_units
for select to authenticated
using (public.depomap_is_org_member(organization_id));
create policy depomap_storage_units_insert on public.storage_units
for insert to authenticated
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_storage_units_update on public.storage_units
for update to authenticated
using (public.depomap_can_edit_org(organization_id))
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_storage_units_delete on public.storage_units
for delete to authenticated
using (public.depomap_can_edit_org(organization_id));

create policy depomap_products_read on public.products
for select to authenticated
using (public.depomap_is_org_member(organization_id));
create policy depomap_products_insert on public.products
for insert to authenticated
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_products_update on public.products
for update to authenticated
using (public.depomap_can_edit_org(organization_id))
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_products_delete on public.products
for delete to authenticated
using (public.depomap_can_edit_org(organization_id));

create policy depomap_storage_contents_read on public.storage_contents
for select to authenticated
using (public.depomap_is_org_member(organization_id));
create policy depomap_storage_contents_insert on public.storage_contents
for insert to authenticated
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_storage_contents_update on public.storage_contents
for update to authenticated
using (public.depomap_can_edit_org(organization_id))
with check (public.depomap_can_edit_org(organization_id));
create policy depomap_storage_contents_delete on public.storage_contents
for delete to authenticated
using (public.depomap_can_edit_org(organization_id));

create policy depomap_inventory_movements_read on public.inventory_movements
for select to authenticated
using (public.depomap_is_org_member(organization_id));
create policy depomap_inventory_movements_insert on public.inventory_movements
for insert to authenticated
with check (public.depomap_can_edit_org(organization_id) and performed_by = auth.uid());

create policy depomap_audit_logs_read on public.audit_logs
for select to authenticated
using (public.depomap_has_org_role(organization_id, array['owner', 'manager']::text[]));

-- Table grants are still constrained by the RLS policies above.
grant usage on schema public to authenticated;
grant select on public.organizations, public.memberships, public.warehouses,
  public.map_objects, public.storage_units, public.products,
  public.storage_contents, public.inventory_movements, public.audit_logs
  to authenticated;
grant insert, update, delete on public.warehouses, public.map_objects,
  public.storage_units, public.products, public.storage_contents
  to authenticated;
grant insert on public.inventory_movements to authenticated;

-- Enable Supabase Realtime for tables read by the application, when the
-- default supabase_realtime publication exists.
do $$
declare
  table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach table_name in array array['warehouses', 'map_objects', 'storage_units', 'products', 'storage_contents']
    loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end loop;
  end if;
end;
$$;
