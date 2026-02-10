-- Supabase schema for ARGUS SPEAK LAB-X Training
-- Ejecuta esto en Supabase SQL Editor.

create table if not exists public.labx_training_sessions (
  id bigserial primary key,
  user_id uuid null,
  topic text null,
  transcript text null,
  autopsy text null,
  created_at timestamptz not null default now()
);

-- RLS recomendado: solo el dueño ve sus sesiones
alter table public.labx_training_sessions enable row level security;

-- Si usas auth, vincula por auth.uid(). En este repo guardamos session.access_token,
-- pero lo ideal es setear user_id = auth.uid() desde el cliente.
create policy "read own sessions"
on public.labx_training_sessions
for select
to authenticated
using (user_id = auth.uid());

create policy "insert own sessions"
on public.labx_training_sessions
for insert
to authenticated
with check (user_id = auth.uid());

-- Opcional: tabla para huella agregada (si luego quieres analytics)
create table if not exists public.labx_error_footprint (
  id bigserial primary key,
  user_id uuid null,
  pattern text not null,
  fix text null,
  example text null,
  created_at timestamptz not null default now()
);

alter table public.labx_error_footprint enable row level security;

create policy "read own footprint"
on public.labx_error_footprint
for select
to authenticated
using (user_id = auth.uid());

create policy "insert own footprint"
on public.labx_error_footprint
for insert
to authenticated
with check (user_id = auth.uid());
