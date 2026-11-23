-- =====================================================================
-- Cervecería · Paso 3: permisos de acceso a las tablas
-- Correr DESPUÉS de 01 y 02 (SQL Editor > New query > Run).
-- Habilita que la app use las tablas; QUÉ filas ve y cambia cada persona
-- lo siguen decidiendo las reglas (RLS) y las funciones de 01 y 02.
-- =====================================================================

grant usage on schema public to anon, authenticated;

-- Menú, lugares y configuración: los ve cualquiera (también antes de iniciar sesión)
grant select on public.config, public.lugares, public.productos to anon, authenticated;

-- Con sesión iniciada: el administrador los edita (las reglas solo se lo permiten a él)
grant insert, update, delete on public.config, public.lugares, public.productos to authenticated;

-- Perfiles: cada uno ve y edita el suyo; el personal ve a los clientes; el admin cambia roles
grant select, update on public.perfiles to authenticated;

-- Pedidos, ítems y ajustes: solo lectura; se crean y cambian por las funciones del servidor
grant select on public.pedidos, public.pedido_items, public.ajustes to authenticated;

-- Contadores de numeración (por ejemplo, para agregar lugares nuevos)
grant usage, select on all sequences in schema public to authenticated;

-- Funciones del negocio: solo con sesión iniciada
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
