-- Initial DepoMap schema. Review and extend RLS before storing real business data.
create extension if not exists pgcrypto;

create type public.member_role as enum ('owner', 'manager', 'worker', 'viewer');
create type public.map_object_type as enum ('pallet', 'rack', 'cart', 'wall', 'aisle');
create type public.storage_unit_type as enum ('pallet', 'rack', 'rack_level', 'rack_bin', 'cart');
create type public.movement_type as enum ('add', 'remove', 'move', 'adjust');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'worker',
  joined_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  width_m numeric(9,2) not null check (width_m > 0),
  length_m numeric(9,2) not null check (length_m > 0),
  grid_size_m numeric(5,2) not null default 0.50 check (grid_size_m > 0),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table public.map_objects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  warehouse_id uuid not null,
  object_type public.map_object_type not null,
  label text not null,
  x_m numeric(9,3) not null default 0,
  y_m numeric(9,3) not null default 0,
  width_m numeric(9,3) not null default 1 check (width_m > 0),
  length_m numeric(9,3) not null default 1 check (length_m > 0),
  rotation_deg numeric(6,2) not null default 0,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (warehouse_id, organization_id) references public.warehouses(id, organization_id) on delete cascade,
  unique (id, organization_id, warehouse_id)
);

create table public.storage_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  warehouse_id uuid not null,
  map_object_id uuid,
  parent_unit_id uuid,
  unit_type public.storage_unit_type not null,
  label text not null,
  level_number integer,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  foreign key (warehouse_id, organization_id) references public.warehouses(id, organization_id) on delete cascade,
  foreign key (map_object_id, organization_id, warehouse_id) references public.map_objects(id, organization_id, warehouse_id) on delete cascade,
  foreign key (parent_unit_id, organization_id, warehouse_id) references public.storage_units(id, organization_id, warehouse_id) on delete cascade,
  unique (id, organization_id, warehouse_id)
);

create unique index one_storage_unit_per_map_object on public.storage_units(map_object_id) where map_object_id is not null;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  barcode text,
  sku text,
  description text,
  unit_name text not null default 'adet',
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index products_barcode_per_org on public.products(organization_id, barcode) where barcode is not null;
create unique index products_sku_per_org on public.products(organization_id, sku) where sku is not null;
create index products_name_search on public.products(organization_id, lower(name));

create table public.storage_contents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  warehouse_id uuid not null,
  storage_unit_id uuid not null,
  product_id uuid not null,
  quantity numeric(14,3),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  check (quantity is null or quantity >= 0),
  foreign key (storage_unit_id, organization_id, warehouse_id) references public.storage_units(id, organization_id, warehouse_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products(id, organization_id) on delete cascade,
  unique (storage_unit_id, product_id)
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  warehouse_id uuid not null,
  product_id uuid not null,
  movement_type public.movement_type not null,
  from_unit_id uuid,
  to_unit_id uuid,
  quantity numeric(14,3),
  quantity_before numeric(14,3),
  quantity_after numeric(14,3),
  note text,
  performed_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  check (quantity is null or quantity >= 0),
  foreign key (product_id, organization_id) references public.products(id, organization_id),
  foreign key (from_unit_id, organization_id, warehouse_id) references public.storage_units(id, organization_id, warehouse_id),
  foreign key (to_unit_id, organization_id, warehouse_id) references public.storage_units(id, organization_id, warehouse_id)
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index contents_product_idx on public.storage_contents(organization_id, product_id);
create index contents_location_idx on public.storage_contents(storage_unit_id);
create index movements_recent_idx on public.inventory_movements(organization_id, warehouse_id, created_at desc);

-- Enable RLS now. Policies must be added before app CRUD is enabled.
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.warehouses enable row level security;
alter table public.map_objects enable row level security;
alter table public.storage_units enable row level security;
alter table public.products enable row level security;
alter table public.storage_contents enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.audit_logs enable row level security;

-- NOTE: No policies are intentionally included in this first scaffold.
-- Until membership-based policies and secure server-side operations are added,
-- do not connect this schema to a public CRUD UI or store real inventory.
