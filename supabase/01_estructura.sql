-- =====================================================================
-- Cervecería · Paso 1: estructura de la base, seguridad y datos iniciales
-- Pegar completo en Supabase > SQL Editor > New query > Run
-- Se puede correr una sola vez sobre un proyecto vacío.
-- =====================================================================

-- ---------- 1. Perfiles y roles ----------
create table public.perfiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  nombre    text not null default '',
  telefono  text,
  rol       text not null default 'cliente' check (rol in ('cliente','mozo','barra','admin')),
  creado    timestamptz not null default now()
);

create or replace function public.mi_rol() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select rol from perfiles where id = auth.uid()), 'anonimo')
$$;
create or replace function public.es_staff() returns boolean
language sql stable as $$ select public.mi_rol() in ('mozo','barra','admin') $$;
create or replace function public.es_admin() returns boolean
language sql stable as $$ select public.mi_rol() = 'admin' $$;

-- Cada usuario nuevo (Google, Facebook, Apple o email) recibe su perfil de cliente
create or replace function public.nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfiles (id, nombre)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name',
                           new.raw_user_meta_data->>'name',
                           split_part(coalesce(new.email,''), '@', 1), ''));
  return new;
end $$;
create trigger al_crear_usuario after insert on auth.users
  for each row execute function public.nuevo_usuario();

-- Nadie se cambia el rol a sí mismo; solo un administrador (o el SQL Editor)
create or replace function public.proteger_rol() returns trigger
language plpgsql as $$
begin
  if new.rol is distinct from old.rol
     and not public.es_admin()
     and current_user not in ('postgres','supabase_admin','service_role') then
    raise exception 'Solo un administrador puede cambiar roles';
  end if;
  return new;
end $$;
create trigger proteger_rol before update on public.perfiles
  for each row execute function public.proteger_rol();

-- ---------- 2. Configuración, lugares y productos ----------
create table public.config (
  id    int primary key default 1 check (id = 1),
  datos jsonb not null
);

create table public.lugares (
  id     serial primary key,
  tipo   text not null check (tipo in ('mesa','barra','retira')),
  nombre text not null unique,
  orden  int not null default 0,
  activo boolean not null default true
);

create table public.productos (
  id           uuid primary key default gen_random_uuid(),
  nombre       text not null,
  descripcion  text not null default '',
  categoria    text not null default 'Otros',
  precio       numeric(12,2) not null check (precio >= 0),
  puntos_extra int not null default 0 check (puntos_extra >= 0),
  es_cerveza   boolean not null default false,
  es_picada    boolean not null default false,
  disponible   boolean not null default true,
  orden        int not null default 0,
  creado       timestamptz not null default now()
);

-- ---------- 3. Pedidos, ítems y ajustes de puntos ----------
create table public.pedidos (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null,
  cliente_id    uuid references public.perfiles(id) on delete set null,
  nombre        text not null default '',
  lugar_id      int not null references public.lugares(id),
  origen        text not null check (origen in ('cliente','mozo','barra')),
  estado        text not null default 'nuevo' check (estado in ('nuevo','prep','listo','entregado','cancelado')),
  total         numeric(12,2) not null default 0,
  puntos        int not null default 0,
  creado_por    uuid references public.perfiles(id) on delete set null,
  creado        timestamptz not null default now(),
  entregado_en  timestamptz,
  entregado_por uuid references public.perfiles(id) on delete set null
);
create index pedidos_abiertos on public.pedidos (estado) where estado in ('nuevo','prep','listo');
create index pedidos_cliente on public.pedidos (cliente_id);

create table public.pedido_items (
  id           bigserial primary key,
  pedido_id    uuid not null references public.pedidos(id) on delete cascade,
  producto_id  uuid references public.productos(id) on delete set null,
  nombre       text not null,
  precio       numeric(12,2) not null,
  cantidad     int not null check (cantidad > 0),
  puntos_extra int not null default 0,
  es_cerveza   boolean not null default false,
  es_picada    boolean not null default false,
  canje_puntos int not null default 0
);
create index items_pedido on public.pedido_items (pedido_id);

create table public.ajustes (
  id         bigserial primary key,
  cliente_id uuid not null references public.perfiles(id) on delete cascade,
  puntos     int not null check (puntos <> 0),
  motivo     text not null,
  por        uuid references public.perfiles(id) on delete set null,
  creado     timestamptz not null default now()
);

-- ---------- 4. Seguridad (Row Level Security) ----------
alter table public.perfiles     enable row level security;
alter table public.config       enable row level security;
alter table public.lugares      enable row level security;
alter table public.productos    enable row level security;
alter table public.pedidos      enable row level security;
alter table public.pedido_items enable row level security;
alter table public.ajustes      enable row level security;

create policy "ver perfil"    on public.perfiles for select using (id = auth.uid() or public.es_staff());
create policy "editar perfil" on public.perfiles for update using (id = auth.uid() or public.es_admin())
                                                    with check (id = auth.uid() or public.es_admin());

create policy "leer config"  on public.config    for select using (true);
create policy "admin config" on public.config    for all using (public.es_admin()) with check (public.es_admin());
create policy "leer lugares" on public.lugares   for select using (true);
create policy "admin lugares" on public.lugares  for all using (public.es_admin()) with check (public.es_admin());
create policy "leer menu"    on public.productos for select using (true);
create policy "admin menu"   on public.productos for all using (public.es_admin()) with check (public.es_admin());

-- Pedidos, ítems y ajustes: se leen según quién sos; se escriben SOLO por las funciones de abajo
create policy "ver pedidos" on public.pedidos for select using (cliente_id = auth.uid() or public.es_staff());
create policy "ver items"   on public.pedido_items for select using (
  exists (select 1 from public.pedidos p where p.id = pedido_id and (p.cliente_id = auth.uid() or public.es_staff())));
create policy "ver ajustes" on public.ajustes for select using (cliente_id = auth.uid() or public.es_staff());

-- ---------- 5. Lógica del negocio (corre en el servidor, no se puede trucar desde el celular) ----------

-- Saldo de puntos: ganados (entregas + ajustes), canjeados y disponibles
create or replace function public.saldo(p_cliente uuid)
returns table (ganados int, canjeados int, disponibles int)
language sql stable security definer set search_path = public as $$
  with g as (
    select coalesce((select sum(puntos) from pedidos where cliente_id = p_cliente and estado = 'entregado'), 0)
         + coalesce((select sum(puntos) from ajustes where cliente_id = p_cliente), 0) as v),
  c as (
    select coalesce(sum(i.canje_puntos * i.cantidad), 0) as v
    from pedido_items i join pedidos p on p.id = i.pedido_id
    where p.cliente_id = p_cliente and p.estado <> 'cancelado')
  select g.v::int, c.v::int, (g.v - c.v)::int from g, c
  where p_cliente = auth.uid() or public.es_staff()
$$;

-- Multiplicador según el nivel alcanzado (sale de config.datos.levels)
create or replace function public.multiplicador(p_ganados int) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (l->>'mult')::numeric
    from config, jsonb_array_elements(datos->'levels') l
    where (l->>'min')::int <= p_ganados
    order by (l->>'min')::int desc limit 1), 1)
$$;

-- Código de 3 cifras que no se repite entre pedidos abiertos
create or replace function public.nuevo_codigo() returns text
language plpgsql security definer set search_path = public as $$
declare c text; n int := 0;
begin
  loop
    c := (100 + floor(random() * 900))::int::text;
    exit when n > 50 or not exists (
      select 1 from pedidos where codigo = c and estado in ('nuevo','prep','listo'));
    n := n + 1;
  end loop;
  return c;
end $$;

-- Crear pedido. Los precios salen de la tabla productos, nunca del celular.
-- p_items: [{"producto_id":"…","cantidad":2}, {"canje":"r-pinta"}]
create or replace function public.crear_pedido(p_items jsonb, p_lugar int,
                                               p_nombre text default null, p_cliente uuid default null)
returns public.pedidos
language plpgsql security definer set search_path = public as $$
declare
  r text := mi_rol(); v pedidos; it jsonb; pr productos; rw jsonb;
  cli uuid; tot numeric := 0; canjes int := 0; disp int; cant int;
begin
  if r = 'anonimo' then raise exception 'Tenés que iniciar sesión'; end if;
  cli := case when r = 'cliente' then auth.uid() else p_cliente end;
  if not exists (select 1 from lugares where id = p_lugar and activo) then raise exception 'Lugar inválido'; end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then raise exception 'El pedido está vacío'; end if;

  insert into pedidos (codigo, cliente_id, nombre, lugar_id, origen, creado_por)
  values (nuevo_codigo(), cli,
          coalesce(nullif(trim(p_nombre), ''), (select nombre from perfiles where id = cli), ''),
          p_lugar,
          case when r in ('mozo','barra') then r when r = 'admin' then 'barra' else 'cliente' end,
          auth.uid())
  returning * into v;

  for it in select * from jsonb_array_elements(p_items) loop
    if it ? 'canje' then
      if cli is null then raise exception 'Los canjes necesitan un cliente identificado'; end if;
      select x into rw from config, jsonb_array_elements(datos->'rewards') x where x->>'id' = it->>'canje';
      if rw is null then raise exception 'Ese canje no existe'; end if;
      insert into pedido_items (pedido_id, nombre, precio, cantidad, canje_puntos)
      values (v.id, 'Canje: ' || (rw->>'n'), 0, 1, (rw->>'pts')::int);
      canjes := canjes + (rw->>'pts')::int;
    else
      cant := coalesce((it->>'cantidad')::int, 0);
      if cant < 1 or cant > 50 then raise exception 'Cantidad inválida'; end if;
      select * into pr from productos where id = (it->>'producto_id')::uuid and disponible;
      if not found then raise exception 'Hay un producto que no está disponible'; end if;
      insert into pedido_items (pedido_id, producto_id, nombre, precio, cantidad, puntos_extra, es_cerveza, es_picada)
      values (v.id, pr.id, pr.nombre, pr.precio, cant, pr.puntos_extra, pr.es_cerveza, pr.es_picada);
      tot := tot + pr.precio * cant;
    end if;
  end loop;

  if canjes > 0 then
    select disponibles into disp from saldo(cli);   -- ya descuenta los canjes de este pedido
    if disp < 0 then raise exception 'No hay puntos suficientes para ese canje'; end if;
  end if;

  update pedidos set total = tot where id = v.id returning * into v;
  return v;
end $$;

-- Avanzar: nuevo → prep → listo → entregado. Al entregar se cobra y se acreditan los puntos.
create or replace function public.avanzar_pedido(p_id uuid) returns public.pedidos
language plpgsql security definer set search_path = public as $$
declare v pedidos; sig text; g int; ppp numeric;
begin
  if not es_staff() then raise exception 'Solo el personal puede avanzar pedidos'; end if;
  select * into v from pedidos where id = p_id for update;
  if not found then raise exception 'Pedido inexistente'; end if;
  sig := case v.estado when 'nuevo' then 'prep' when 'prep' then 'listo' when 'listo' then 'entregado' end;
  if sig is null then raise exception 'El pedido ya está cerrado'; end if;

  if sig = 'entregado' then
    if v.cliente_id is not null then
      select ganados into g from saldo(v.cliente_id);
      select greatest(coalesce((datos->>'ppp')::numeric, 100), 1) into ppp from config where id = 1;
      v.puntos := floor(v.total / ppp * multiplicador(g))::int
                + coalesce((select sum(puntos_extra * cantidad) from pedido_items
                            where pedido_id = v.id and canje_puntos = 0), 0);
    end if;
    update pedidos set estado = sig, puntos = v.puntos, entregado_en = now(), entregado_por = auth.uid()
    where id = p_id returning * into v;
  else
    update pedidos set estado = sig where id = p_id returning * into v;
  end if;
  return v;
end $$;

create or replace function public.anular_pedido(p_id uuid) returns public.pedidos
language plpgsql security definer set search_path = public as $$
declare v pedidos;
begin
  if not es_staff() then raise exception 'Solo el personal puede anular pedidos'; end if;
  update pedidos set estado = 'cancelado' where id = p_id and estado in ('nuevo','prep') returning * into v;
  if not found then raise exception 'Solo se anulan pedidos que no están listos'; end if;
  return v;
end $$;

-- El cliente suma a su cuenta un pedido que hizo sin identificarse, usando el código
create or replace function public.vincular_pedido(p_codigo text) returns public.pedidos
language plpgsql security definer set search_path = public as $$
declare v pedidos;
begin
  if auth.uid() is null then raise exception 'Tenés que iniciar sesión'; end if;
  select * into v from pedidos
  where codigo = trim(p_codigo) and estado in ('nuevo','prep','listo') for update;
  if not found then raise exception 'No hay un pedido abierto con ese código'; end if;
  if v.cliente_id is not null and v.cliente_id <> auth.uid() then
    raise exception 'Ese pedido ya está a nombre de otra persona';
  end if;
  update pedidos set cliente_id = auth.uid(),
         nombre = coalesce(nullif(nombre, ''), (select nombre from perfiles where id = auth.uid()))
  where id = v.id returning * into v;
  return v;
end $$;

-- El cliente avisa dónde está; se actualizan sus pedidos abiertos
create or replace function public.cambiar_lugar(p_lugar int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Tenés que iniciar sesión'; end if;
  if not exists (select 1 from lugares where id = p_lugar and activo) then raise exception 'Lugar inválido'; end if;
  update pedidos set lugar_id = p_lugar
  where cliente_id = auth.uid() and estado in ('nuevo','prep','listo');
end $$;

-- Ajuste manual de puntos (solo administrador)
create or replace function public.ajustar_puntos(p_cliente uuid, p_puntos int, p_motivo text) returns public.ajustes
language plpgsql security definer set search_path = public as $$
declare a ajustes;
begin
  if not es_admin() then raise exception 'Solo el administrador ajusta puntos'; end if;
  if coalesce(trim(p_motivo), '') = '' then raise exception 'Indicá un motivo'; end if;
  insert into ajustes (cliente_id, puntos, motivo, por) values (p_cliente, p_puntos, trim(p_motivo), auth.uid())
  returning * into a;
  return a;
end $$;

-- ---------- 6. Tiempo real: el celular del cliente se entera cuando su pedido cambia ----------
alter publication supabase_realtime add table public.pedidos;

-- ---------- 7. Datos iniciales (editables después desde Administración) ----------
insert into public.config (id, datos) values (1, '{
  "local": "Cervecería La Barrica",
  "ppp": 100,
  "bonus": 100,
  "premio": "una picada para 2",
  "levels": [
    {"n":"Bronce","min":0,"mult":1,"perk":"Suma puntos en cada consumo"},
    {"n":"Plata","min":1500,"mult":1.2,"perk":"20% más puntos"},
    {"n":"Oro","min":4000,"mult":1.5,"perk":"50% más puntos y mesa reservada los viernes"}],
  "rewards": [
    {"id":"r-pinta","n":"Pinta gratis","pts":400},
    {"id":"r-papas","n":"Papas rústicas gratis","pts":550},
    {"id":"r-picada","n":"Picada para 2 gratis","pts":1500}],
  "badges": {
    "primera":{"on":true,"goal":1},"explorador":{"on":true,"goal":6},"habitue":{"on":true,"goal":5},
    "jueves":{"on":true,"goal":3},"picadero":{"on":true,"goal":3},"ronda":{"on":true,"goal":4}}
}');

insert into public.lugares (tipo, nombre, orden)
select 'mesa', 'Mesa ' || n, n from generate_series(1, 10) n;
insert into public.lugares (tipo, nombre, orden) values
  ('barra', 'Barra alta 1', 101), ('barra', 'Barra alta 2', 102), ('barra', 'Barra alta 3', 103),
  ('barra', 'Deck de pie', 104), ('retira', 'Retira en barra', 0);

insert into public.productos (nombre, descripcion, categoria, precio, puntos_extra, es_cerveza, es_picada, orden) values
  ('Golden Ale', 'Rubia, liviana y fresca · 4,8%', 'Cervezas', 5500, 0, true, false, 1),
  ('Honey', 'Con miel de la zona · 6%', 'Cervezas', 6000, 0, true, false, 2),
  ('APA', 'Lúpulo cítrico, amargor medio · 5,5%', 'Cervezas', 6000, 0, true, false, 3),
  ('IPA', 'Bien lupulada y amarga · 6,5%', 'Cervezas', 6500, 0, true, false, 4),
  ('Scottish', 'Roja y maltosa, notas a caramelo · 5,8%', 'Cervezas', 6000, 0, true, false, 5),
  ('Stout', 'Negra, café y chocolate · 6%', 'Cervezas', 6500, 20, true, false, 6),
  ('Maní salado', 'Para picar mientras llega lo demás', 'Para acompañar', 2500, 0, false, false, 10),
  ('Papas rústicas', 'Con alioli de la casa', 'Para acompañar', 7500, 0, false, false, 11),
  ('Papas cheddar y panceta', 'La que más sale', 'Para acompañar', 9500, 0, false, false, 12),
  ('Nachos con guacamole', 'Para compartir', 'Para acompañar', 9000, 0, false, false, 13),
  ('Provoleta', 'Con orégano y tomates asados', 'Para acompañar', 9500, 0, false, false, 14),
  ('Picada para 2', 'Fiambres, quesos, aceitunas y pan', 'Para acompañar', 19000, 0, false, true, 15),
  ('Hamburguesa de la casa', 'Doble cheddar, con papas', 'Para acompañar', 14000, 0, false, false, 16);
