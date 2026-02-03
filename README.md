# ARGUS SPEAK LAB-X — Article + AI (PWA)

Este prototipo es una PWA instalable (Android/Chrome) y se conecta a IA vía una función serverless.

## 1) Correr local (sin IA)
- Python: `python -m http.server 8080`
- Abre: `http://localhost:8080`

## 2) Conectar IA (Netlify recomendado)
1. Crea un sitio en Netlify desde esta carpeta.
2. **Site settings → Environment variables**
   - `OPENAI_API_KEY` = tu llave
   - (opcional) `OPENAI_MODEL` = `gpt-5`

3. Deploy.

La app llama a `POST /api/ai` que Netlify redirige a `/.netlify/functions/ai`.

## 3) Instalar en Android
Chrome → Menú ⋮ → **Instalar app**

## Seguridad
Nunca pongas la API key en el front. Debe vivir en el servidor.


## Suscripción (PRO) + IA segura (OpenAI) — Setup rápido

Esta app está pensada para:
- **Frontend estático** (PWA) en Netlify
- **Funciones** Netlify para IA y pagos
- **Auth + DB** con Supabase
- **Suscripción** con Stripe

### 1) Crea Supabase
1. Crea un proyecto en Supabase.
2. Crea la tabla `profiles`:

```sql
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text default 'inactive',
  subscription_current_period_end timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "profiles: read own" on public.profiles
for select to authenticated
using (auth.uid() = id);

create policy "profiles: insert own" on public.profiles
for insert to authenticated
with check (auth.uid() = id);

create policy "profiles: update own" on public.profiles
for update to authenticated
using (auth.uid() = id);

-- trigger opcional para updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute procedure public.set_updated_at();
```

> Nota: las Netlify Functions usan `SUPABASE_SERVICE_ROLE_KEY` para actualizar perfiles desde webhooks.
### 1.1) AI quota (FREE vs PRO)
Para evitar que un usuario consuma IA ilimitada, la función `/api/ai` aplica un **límite diario**:

- FREE: `1` uso / día
- PRO: `50` usos / día

Puedes cambiarlo desde Netlify con variables:
- `FREE_DAILY_AI_LIMIT` (default 1)
- `PRO_DAILY_AI_LIMIT` (default 50)

En Supabase, corre este SQL (una vez) para agregar contadores diarios + RPC atómico:

```sql
alter table public.profiles
  add column if not exists daily_ai_requests int not null default 0,
  add column if not exists daily_ai_reset_date date not null default current_date;

create or replace function public.consume_ai_quota(p_user_id uuid, p_limit int, p_today date)
returns table(allowed boolean, used int, remaining int, limit int, reset_date date)
language plpgsql
security definer
set search_path = public
as $$
declare cur_used int;
declare cur_date date;
begin
  insert into public.profiles (id) values (p_user_id)
  on conflict (id) do nothing;

  select daily_ai_requests, daily_ai_reset_date
    into cur_used, cur_date
  from public.profiles
  where id = p_user_id
  for update;

  if cur_date != p_today then
    cur_used := 0;
    cur_date := p_today;
  end if;

  if cur_used >= p_limit then
    update public.profiles
    set daily_ai_requests = cur_used,
        daily_ai_reset_date = cur_date
    where id = p_user_id;

    return query select false, cur_used, 0, p_limit, cur_date;
    return;
  end if;

  cur_used := cur_used + 1;

  update public.profiles
  set daily_ai_requests = cur_used,
      daily_ai_reset_date = cur_date
  where id = p_user_id;

  return query select true, cur_used, (p_limit - cur_used), p_limit, cur_date;
end;
$$;

create or replace function public.refund_ai_quota(p_user_id uuid, p_today date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set daily_ai_requests = greatest(daily_ai_requests - 1, 0)
  where id = p_user_id
    and daily_ai_reset_date = p_today
    and daily_ai_requests > 0;
end;
$$;
```


### 2) Crea Stripe
1. Crea un **Producto** y un **Precio recurrente** (mensual/anual).
2. En Netlify usa el **Price ID** en variable `STRIPE_PRICE_ID`.
3. Crea un **Webhook endpoint** apuntando a:
   `/api/stripe-webhook`
   y copia el **Signing Secret**.

### 3) Variables de entorno en Netlify
En Netlify → Site settings → Environment variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (opcional; ej: `gpt-5.2-mini`)
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID`
- `STRIPE_WEBHOOK_SECRET`

### 4) Flujo
- El usuario entra por email (link mágico).
- Se suscribe (Stripe Checkout).
- Webhook actualiza `profiles.subscription_status`.
- La función `/api/ai` aplica cuota diaria: FREE=1/día, PRO=50/día (configurable).
