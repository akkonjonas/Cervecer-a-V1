-- =====================================================================
-- Cervecería · Paso 2: email en perfiles, insignias, ranking y resumen de clientes
-- Correr DESPUÉS de 01_estructura.sql (SQL Editor > New query > Run)
-- =====================================================================

-- Email visible en el perfil (para que el administrador encuentre al personal)
alter table public.perfiles add column if not exists email text;
update public.perfiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;

create or replace function public.nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfiles (id, nombre, email)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name',
                   split_part(coalesce(new.email,''), '@', 1), ''),
          new.email);
  return new;
end $$;

-- Progreso de insignias, calculado en el servidor con las metas de config.datos.badges
create or replace function public.progreso_insignias(p_cliente uuid)
returns table (id text, valor int, meta int, ok boolean)
language sql stable security definer set search_path = public as $$
  with e as (
    select p.id, (p.entregado_en at time zone 'America/Argentina/Buenos_Aires')::date as dia
    from pedidos p where p.cliente_id = p_cliente and p.estado = 'entregado'),
  it as (
    select i.*, i.pedido_id as pid from pedido_items i join e on e.id = i.pedido_id where i.canje_puntos = 0),
  v as (
    select 'primera'::text as id, (select count(*) from e)::int as valor
    union all select 'explorador', (select count(distinct producto_id) from it where es_cerveza)::int
    union all select 'habitue',    (select count(distinct dia) from e)::int
    union all select 'jueves',     (select count(distinct dia) from e where extract(isodow from dia) = 4)::int
    union all select 'picadero',   (select coalesce(sum(cantidad), 0) from it where es_picada)::int
    union all select 'ronda',      (select coalesce(max(s), 0) from (select sum(cantidad) s from it where es_cerveza group by pid) x)::int)
  select v.id, v.valor,
         greatest(coalesce((c.datos->'badges'->v.id->>'goal')::int, 1), 1),
         v.valor >= greatest(coalesce((c.datos->'badges'->v.id->>'goal')::int, 1), 1)
  from v cross join config c
  where c.id = 1
    and coalesce((c.datos->'badges'->v.id->>'on')::boolean, false)
    and (p_cliente = auth.uid() or public.es_staff())
$$;

-- Saldo: ahora suma el bonus por cada insignia ganada
create or replace function public.saldo(p_cliente uuid)
returns table (ganados int, canjeados int, disponibles int)
language sql stable security definer set search_path = public as $$
  with b as (
    select count(*) filter (where ok)
           * coalesce((select (datos->>'bonus')::int from config where id = 1), 0) as v
    from progreso_insignias(p_cliente)),
  g as (
    select coalesce((select sum(puntos) from pedidos where cliente_id = p_cliente and estado = 'entregado'), 0)
         + coalesce((select sum(puntos) from ajustes where cliente_id = p_cliente), 0)
         + (select v from b) as v),
  c as (
    select coalesce(sum(i.canje_puntos * i.cantidad), 0) as v
    from pedido_items i join pedidos p on p.id = i.pedido_id
    where p.cliente_id = p_cliente and p.estado <> 'cancelado')
  select g.v::int, c.v::int, (g.v - c.v)::int from g, c
  where p_cliente = auth.uid() or public.es_staff()
$$;

-- Ranking del mes: nombre + inicial del apellido, para cuidar la privacidad
create or replace function public.ranking_mes(p_limite int default 10)
returns table (posicion int, nombre text, puntos int, soy_yo boolean)
language sql stable security definer set search_path = public as $$
  with m as (
    select cliente_id, sum(puntos)::int as pts
    from pedidos
    where estado = 'entregado' and cliente_id is not null
      and date_trunc('month', entregado_en at time zone 'America/Argentina/Buenos_Aires')
        = date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires')
    group by cliente_id having sum(puntos) > 0),
  r as (select cliente_id, pts, (rank() over (order by pts desc))::int as pos from m)
  select r.pos,
         split_part(p.nombre, ' ', 1) || coalesce(' ' || left(nullif(split_part(p.nombre, ' ', 2), ''), 1) || '.', ''),
         r.pts, r.cliente_id = auth.uid()
  from r join perfiles p on p.id = r.cliente_id
  where auth.uid() is not null and (r.pos <= p_limite or r.cliente_id = auth.uid())
  order by r.pos
$$;

-- Lista de clientes con su saldo (solo administrador)
create or replace function public.clientes_resumen()
returns table (id uuid, nombre text, email text, telefono text, rol text,
               ganados int, canjeados int, disponibles int, creado timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not es_admin() then raise exception 'Solo el administrador ve el listado de clientes'; end if;
  return query
    select p.id, p.nombre, p.email, p.telefono, p.rol, s.ganados, s.canjeados, s.disponibles, p.creado
    from perfiles p cross join lateral saldo(p.id) s
    where p.rol = 'cliente'
    order by s.ganados desc, p.creado desc;
end $$;
