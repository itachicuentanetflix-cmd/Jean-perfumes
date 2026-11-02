-- JEAN PERFUMES · pegar completo en Neon > SQL Editor y ejecutar (una sola vez)
create extension if not exists pgcrypto;

create table users(id uuid primary key default gen_random_uuid(), username text not null,
  password_hash text not null, must_change boolean not null default true, created_at timestamptz not null default now());
create unique index users_name_uq on users(lower(username));

create table sessions(id text primary key, user_id uuid not null references users(id) on delete cascade, expires_at timestamptz not null);
create table login_attempts(id bigserial primary key, key text not null, at timestamptz not null default now());
create index login_attempts_idx on login_attempts(key, at);

create table suppliers(id uuid primary key default gen_random_uuid(), name text not null, country text, contact text,
  active boolean not null default true, created_at timestamptz not null default now());

create table perfumes(id uuid primary key default gen_random_uuid(), sku text not null unique, name text not null, brand text,
  price integer not null default 0 check (price >= 0),          -- precio recomendado en céntimos de sol
  min_stock integer not null default 3, active boolean not null default true,
  hist jsonb not null default '[]', created_at timestamptz not null default now());
create index perfumes_name_idx on perfumes(lower(name));

-- Un lote = una línea de compra. Todos los importes en céntimos de PEN (enteros, sin flotantes).
create table lots(id uuid primary key default gen_random_uuid(),
  perfume_id uuid not null references perfumes(id), supplier_id uuid not null references suppliers(id),
  qty integer not null check (qty > 0), avail integer not null,
  buy integer not null, cus integer not null default 0, sha integer not null default 0,
  bcp integer not null default 0, oth integer not null default 0,
  prov boolean not null default false, rec boolean not null default false,
  ref text, fx numeric(12,6), received_at timestamptz, created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint lot_avail_range check (avail >= 0 and avail <= qty));
create index lots_perfume_idx on lots(perfume_id);

create table sales(code text primary key, idem text not null unique, at timestamptz not null default now(),
  cust text, pay text not null, total integer not null, paid integer not null, cost integer not null, profit integer not null,
  status text not null default 'ok', items jsonb not null, ship jsonb, below boolean not null default false,
  void_at timestamptz, created_by uuid references users(id));
create index sales_at_idx on sales(at desc);

create table movements(id bigserial primary key, lot_id uuid not null references lots(id), type text not null,
  qty integer not null, ref text, user_id uuid, at timestamptz not null default now());
create table audit(id bigserial primary key, at timestamptz not null default now(), user_id uuid, action text not null, detail jsonb);
