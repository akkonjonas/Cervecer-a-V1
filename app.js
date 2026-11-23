// =====================================================================
// Cervecería · app de pedidos, seguimiento y fidelidad
// Una sola app para cliente, mozo, barra y administración.
// Lo que maneja plata y puntos lo resuelve la base (ver /supabase).
// =====================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY, PROVIDERS, PASSKEYS } from './config.js';

/* ---------- utilidades ---------- */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$ ' + Math.round(+n || 0).toLocaleString('es-AR');
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const digits = s => String(s || '').replace(/\D/g, '');
const ago = t => { const m = Math.round((Date.now() - new Date(t)) / 6e4); return m < 1 ? 'recién' : m < 60 ? `hace ${m} min` : `hace ${Math.floor(m / 60)} h`; };
const fecha = t => t ? new Date(t).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) : '';
const isToday = t => t && new Date(t).toDateString() === new Date().toDateString();
const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
const BASE = location.origin + location.pathname;
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 2800); }
const fail = e => { console.error(e); toast(e?.message || 'Algo salió mal'); };

/* ---------- configuración pendiente ---------- */
if (!SUPABASE_URL.startsWith('https://') || SUPABASE_URL.includes('TU-PROYECTO') || SUPABASE_KEY.startsWith('TU-')) {
  $('#app').innerHTML = `<div class="cfg card"><h2>Falta conectar la base</h2>
  <p>Abrí <code>config.js</code> y completá <code>SUPABASE_URL</code> y <code>SUPABASE_KEY</code> con los datos de
  Supabase &gt; Project Settings &gt; API. Los pasos completos están en el README.</p></div>`;
  throw new Error('config.js sin completar');
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, ...(PASSKEYS ? { experimental: { passkey: true } } : {}) }
});
const passkeyOK = () => PASSKEYS && !!window.PublicKeyCredential && typeof sb.auth.signInWithPasskey === 'function';

/* ---------- estado ---------- */
const S = { user: null, perfil: null, cfg: null, lugares: [], productos: [], pedidos: [], ajustes: [], saldo: null, insignias: [], ranking: [], clientes: null, personal: [], hist: null };
const ui = { view: null, ct: 'pedido', at: 'resumen', cart: { cliente: [], mozo: [], barra: [] }, f: {}, auth: 'inicio', email: '', draft: null, sel: null, nb: false, pick: false, q: '' };
let channel = null, pend = false, reloadT = null, lastUid = null;
const qp = new URLSearchParams(location.search);
if (qp.get('lugar')) lsSet('lugar', qp.get('lugar'));            // viene del QR de la mesa

const ROLES = { cliente: 'Cliente', mozo: 'Mozo', barra: 'Barra', admin: 'Administración' };
const ACCESS = { cliente: ['cliente'], mozo: ['mozo'], barra: ['barra'], admin: ['admin', 'mozo', 'barra'] };
const LBL = { nuevo: 'Recibido', prep: 'Preparando', listo: '¡Listo!', entregado: 'Entregado', cancelado: 'Anulado' };
const BADGES = {
  primera: { ic: '1', n: 'Primera pinta', d: g => 'Tu primer consumo' },
  explorador: { ic: 'E', n: 'Explorador', d: g => `Probá ${g} cervezas distintas` },
  habitue: { ic: 'H', n: 'Habitué', d: g => `Vení ${g} días distintos` },
  jueves: { ic: 'J', n: 'Jueves cervecero', d: g => `Vení ${g} jueves distintos` },
  picadero: { ic: 'P', n: 'Picadero', d: g => `Pedí ${g} picadas` },
  ronda: { ic: 'R', n: 'Ronda para todos', d: g => `${g} cervezas o más en un pedido` }
};
const rol = () => S.perfil?.rol || 'cliente';
const cfg = () => S.cfg || { ppp: 100, bonus: 100, levels: [{ n: 'Bronce', min: 0, mult: 1, perk: '' }], rewards: [], badges: {}, premio: '', local: 'Cervecería' };
const lugarById = id => S.lugares.find(l => String(l.id) === String(id));
const lugarDe = p => p.lugar || lugarById(p.lugar_id) || { nombre: '—', tipo: 'mesa' };
const activos = () => S.lugares.filter(l => l.activo);
const code = o => o.codigo;

/* ---------- carga de datos ---------- */
async function loadPublic() {
  const [c, l, p] = await Promise.all([
    sb.from('config').select('datos').eq('id', 1).maybeSingle(),
    sb.from('lugares').select('*').order('orden'),
    sb.from('productos').select('*').order('orden')
  ]);
  if (c.error || l.error || p.error) throw (c.error || l.error || p.error);
  S.cfg = c.data?.datos || null; S.lugares = l.data || []; S.productos = p.data || [];
  $('#brand').textContent = cfg().local || 'Cervecería';
  document.title = cfg().local || 'Cervecería';
}
const SEL = '*, pedido_items(*), lugar:lugares(id,nombre,tipo)';
async function loadPedidos() {
  let q = sb.from('pedidos').select(SEL);
  if (rol() === 'cliente') q = q.eq('cliente_id', S.user.id).order('creado', { ascending: false }).limit(60);
  else q = q.or(`estado.in.(nuevo,prep,listo),entregado_en.gte."${startOfDay()}"`).order('creado');
  const { data, error } = await q; if (error) throw error;
  S.pedidos = data || [];
}
async function loadCliente() {
  const uid = S.user.id;
  const [s, i, r, a] = await Promise.all([
    sb.rpc('saldo', { p_cliente: uid }), sb.rpc('progreso_insignias', { p_cliente: uid }),
    sb.rpc('ranking_mes', { p_limite: 5 }), sb.from('ajustes').select('*').eq('cliente_id', uid).order('creado', { ascending: false })
  ]);
  S.saldo = (s.data && s.data[0]) || { ganados: 0, canjeados: 0, disponibles: 0 };
  S.insignias = i.data || []; S.ranking = r.data || []; S.ajustes = a.data || [];
}
async function loadAll() {
  await loadPedidos();
  if (rol() === 'cliente') await loadCliente();
  if (rol() === 'admin') { const r = await sb.rpc('ranking_mes', { p_limite: 10 }); S.ranking = r.data || []; }
}
function scheduleReload() {
  clearTimeout(reloadT);
  reloadT = setTimeout(async () => { try { await loadAll(); render(); } catch (e) { fail(e); } }, 250);
}
function subscribe() {
  if (channel) sb.removeChannel(channel);
  channel = sb.channel('pedidos-' + S.user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, scheduleReload)
    .subscribe();
}

/* ---------- sesión ---------- */
async function handleSession(session) {
  try {
    if (!session) {
      S.user = null; S.perfil = null; lastUid = null;
      if (channel) { sb.removeChannel(channel); channel = null; }
      await loadPublic(); ui.view = 'login'; render(true); return;
    }
    if (session.user.id === lastUid && S.perfil) return;
    lastUid = session.user.id; S.user = session.user;
    let p = null;
    for (let i = 0; i < 3 && !p; i++) {
      const r = await sb.from('perfiles').select('*').eq('id', S.user.id).maybeSingle();
      p = r.data; if (!p) await new Promise(r => setTimeout(r, 600));
    }
    if (!p) throw new Error('No se encontró tu perfil. Probá cerrar sesión y volver a entrar.');
    S.perfil = p;
    await loadPublic(); await loadAll(); subscribe();
    const h = location.hash.slice(1);
    ui.view = ACCESS[rol()].includes(h) ? h : ACCESS[rol()][0];
    if (rol() === 'cliente') {
      const pre = lsGet('lugar'); const l = pre && (lugarById(pre) || S.lugares.find(x => x.nombre === pre));
      if (l) { lsSet('lugar', l.id); if (qp.get('lugar')) { sb.rpc('cambiar_lugar', { p_lugar: l.id }).then(() => {}); history.replaceState(null, '', BASE); } }
      if (!S.perfil.nombre) ui.ct = 'cuenta';
    }
    render(true);
  } catch (e) { fail(e); $('#app').innerHTML = `<div class="cfg card"><h2>No se pudo cargar</h2><p>${esc(e.message)}</p><button class="pri" data-a="logout">Cerrar sesión</button></div>`; }
}
sb.auth.onAuthStateChange((ev, session) => {
  if (ev === 'PASSWORD_RECOVERY') { ui.auth = 'nuevaClave'; ui.view = 'login'; setTimeout(() => render(true), 0); return; }
  if (ev === 'TOKEN_REFRESHED' || ev === 'USER_UPDATED') return;
  setTimeout(() => handleSession(session), 0);      // nunca esperar a Supabase dentro de este callback
});

/* ---------- ingreso ---------- */
function vLogin() {
  const a = ui.auth;
  if (a === 'nuevaClave') return `<form id="f-newpass" class="auth card"><h2>Nueva contraseña</h2>
    <label>Contraseña nueva<input id="np" type="password" minlength="8" required autocomplete="new-password"></label>
    <button class="pri" type="submit">Guardar</button></form>`;
  if (a === 'personal') return `<form id="f-staff" class="auth card"><h2>Ingreso del personal</h2>
    <label>Email<input id="se" type="email" required autocomplete="username" value="${esc(ui.email)}"></label>
    <label>Contraseña<input id="sp" type="password" required autocomplete="current-password"></label>
    <button class="pri" type="submit">Entrar</button>
    <button type="button" class="linkbtn" data-a="olvide">Olvidé mi contraseña</button>
    <button type="button" class="linkbtn" data-a="auth" data-k="inicio">Volver</button></form>`;
  if (a === 'codigo') return `<form id="f-otp" class="auth card"><h2>Revisá tu email</h2>
    <p class="mute" style="margin:0">Te mandamos un código a <b>${esc(ui.email)}</b>. También podés tocar el link del email.</p>
    <label>Código<input id="otp" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required></label>
    <button class="pri" type="submit">Entrar</button>
    <button type="button" class="linkbtn" data-a="auth" data-k="inicio">Usar otro email</button></form>`;
  const names = { google: 'Google', facebook: 'Facebook', apple: 'Apple' };
  const lugar = lugarById(lsGet('lugar'));
  return `<div class="auth"><h2>Entrá para pedir y sumar puntos</h2>
    ${lugar ? `<div class="chip" style="justify-self:start">${esc(lugar.tipo === 'retira' ? 'Retiro en la barra' : lugar.nombre)}</div>` : ''}
    ${PROVIDERS.map(p => `<button class="prov" data-a="oauth" data-k="${p}">Continuar con ${names[p] || p}</button>`).join('')}
    ${passkeyOK() ? `<button class="pk" data-a="pkin">Entrar con huella o cara</button>` : ''}
    <div class="sep">o con tu email, sin contraseña</div>
    <form id="f-mail" class="row" style="flex-wrap:nowrap"><input id="em" type="email" required placeholder="tu@email.com" autocomplete="email" value="${esc(ui.email)}" aria-label="Email"><button class="pri" type="submit">Recibir código</button></form>
    <p class="small mute" style="margin:0">Al entrar aceptás que guardemos tu nombre y tus consumos para el programa de puntos.</p>
    <button class="linkbtn" data-a="auth" data-k="personal" style="justify-self:center">Soy del personal</button></div>`;
}

/* ---------- carrito y pedidos ---------- */
const cartTotal = c => c.reduce((a, b) => a + b.p * b.q, 0);
const lvls = () => [...cfg().levels].sort((a, b) => a.min - b.min);
const levelOf = p => lvls().filter(l => p >= l.min).pop() || lvls()[0];
const estimate = (total, items, ganados) => Math.floor(total / Math.max(1, cfg().ppp) * (levelOf(ganados || 0).mult || 1)) + items.reduce((a, i) => a + (i.canje ? 0 : (i.extra || 0) * i.q), 0);
function add(role, id) {
  const m = S.productos.find(x => x.id === id); if (!m || !m.disponible) return;
  const c = ui.cart[role], l = c.find(x => x.id === id && !x.canje);
  if (l) l.q++; else c.push({ id: m.id, n: m.nombre, p: +m.precio, q: 1, extra: m.puntos_extra || 0 });
  toast(m.nombre + ' agregado'); render(true);
}
function qty(role, i, d) { const c = ui.cart[role]; c[i].q += d; if (c[i].q <= 0 || c[i].canje) c.splice(i, 1); render(true); }
function redeem(rid) {
  const r = cfg().rewards.find(x => x.id === rid); if (!r) return;
  const usados = ui.cart.cliente.reduce((a, b) => a + (b.canje || 0), 0);
  if ((S.saldo?.disponibles || 0) - usados < r.pts) return toast('Te faltan puntos para este canje');
  ui.cart.cliente.push({ id: r.id, n: 'Canje: ' + r.n, p: 0, q: 1, canje: +r.pts }); ui.ct = 'pedir';
  toast('Canje agregado: confirmá el pedido abajo'); render(true);
}
async function send(role) {
  const c = ui.cart[role]; if (!c.length) return;
  const f = ui.f; let lugarId, nombre = null, cliente = null;
  if (role === 'cliente') { lugarId = lsGet('lugar'); if (!lugarById(lugarId)) { ui.pick = true; render(true); return toast('Tocá dónde estás'); } }
  else {
    const l = S.lugares.find(x => x.nombre === f[role + 'L']); if (!l) return toast('Elegí dónde está el cliente');
    lugarId = l.id; nombre = (f[role + 'N'] || '').trim() || null;
    const tel = digits(f[role + 'T']);
    if (tel) { const r = await sb.from('perfiles').select('id,nombre').eq('telefono', tel).limit(1); if (r.data?.[0]) { cliente = r.data[0].id; nombre = nombre || r.data[0].nombre; } else toast('No hay un cliente con ese teléfono; el pedido sale sin puntos'); }
    if (l.tipo === 'retira' && !nombre) return toast('Poné un nombre para llamarlo cuando esté listo');
  }
  const p_items = c.map(x => x.canje ? { canje: x.id } : { producto_id: x.id, cantidad: x.q });
  const btn = $(`[data-a=send][data-r=${role}]`); if (btn) btn.disabled = true;
  const { data, error } = await sb.rpc('crear_pedido', { p_items, p_lugar: +lugarId, p_nombre: nombre, p_cliente: cliente });
  if (btn) btn.disabled = false;
  if (error) return fail(error);
  ui.cart[role] = [];
  if (role === 'cliente') { ui.ct = 'pedido'; toast('Pedido ' + data.codigo + ' enviado a la barra'); }
  else { f[role + 'T'] = ''; f[role + 'N'] = ''; modal(data, lugarById(lugarId)); }
  await loadAll(); render(true);
}
function modal(o, l) {
  $('#md-c').textContent = o.codigo;
  $('#md-p').innerHTML = `Decile este número a ${o.nombre ? esc(o.nombre) : 'el cliente'} para que siga su pedido desde el celular.<br><b>${esc(l?.nombre || '')}</b> · ${money(o.total)}`;
  $('#modal').hidden = false; $('#modal button').focus();
}
async function advance(id) {
  const { data, error } = await sb.rpc('avanzar_pedido', { p_id: id }); if (error) return fail(error);
  if (data.estado === 'entregado') toast(`Pedido ${data.codigo} entregado y cobrado: ${money(data.total)}${data.puntos ? ' · +' + data.puntos + ' pts' : ''}`);
  await loadAll(); render(true);
}
async function cancel(id) { const { error } = await sb.rpc('anular_pedido', { p_id: id }); if (error) return fail(error); await loadAll(); render(true); }

/* ---------- aviso de pedido listo ---------- */
let actx = null;
function ding() { try { if (!actx) return; const t = actx.currentTime;[880, 1320].forEach((f, i) => { const o = actx.createOscillator(), g = actx.createGain(); o.frequency.value = f; g.gain.setValueAtTime(.0001, t + i * .16); g.gain.exponentialRampToValueAtTime(.3, t + i * .16 + .02); g.gain.exponentialRampToValueAtTime(.0001, t + i * .16 + .4); o.connect(g).connect(actx.destination); o.start(t + i * .16); o.stop(t + i * .16 + .45); }); } catch {} }
function checkReady() {
  if (ui.view !== 'cliente' || !$('#ready').hidden) return;
  const seen = lsGet('vistos') || [], o = S.pedidos.find(x => x.estado === 'listo' && !seen.includes(x.id)); if (!o) return;
  lsSet('vistos', [...seen, o.id].slice(-80));
  const l = lugarDe(o), beer = o.pedido_items.some(i => i.es_cerveza);
  const titulo = beer ? '¡Tu cerveza está lista!' : '¡Tu pedido está listo!';
  const cuerpo = l.tipo === 'retira' ? 'Pasá a retirarlo por la barra y decí tu código.' : 'El mozo te lo lleva a ' + l.nombre + '.';
  $('#rd-c').textContent = 'Pedido ' + o.codigo; $('#rd-t').textContent = titulo; $('#rd-p').textContent = cuerpo;
  const box = $('#ready'); box.querySelectorAll('i').forEach(x => x.remove());
  const cols = ['#ffd166', '#fff', '#f0ac3c', '#b8f2c2'];
  for (let i = 0; i < 28; i++) { const c = document.createElement('i'); c.style.left = Math.random() * 100 + '%'; c.style.background = cols[i % 4]; c.style.animationDelay = Math.random() * .8 + 's'; box.appendChild(c); }
  box.hidden = false; try { navigator.vibrate && navigator.vibrate([120, 80, 120, 80, 260]); } catch {}
  ding(); box.querySelector('button').focus();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker)
    navigator.serviceWorker.ready.then(r => r.showNotification(titulo + ' · Pedido ' + o.codigo, { body: cuerpo, tag: o.id, icon: 'icons/icon-192.png', vibrate: [120, 80, 120] })).catch(() => {});
}

/* ---------- piezas compartidas ---------- */
const cats = () => [...new Set(S.productos.map(m => m.categoria))];
function menuList(role) {
  return cats().map(cat => `<div class="cat">${esc(cat)}</div>` + S.productos.filter(m => m.categoria === cat).map(m => `<div class="item${m.disponible ? '' : ' off'}"><div class="sp"><b>${esc(m.nombre)}${m.puntos_extra ? ` <span class="pill hop">+${m.puntos_extra} pts</span>` : ''}</b><span class="mute small">${m.disponible ? esc(m.descripcion) : 'Sin stock por hoy'}</span></div>
  <span class="num">${money(m.precio)}</span><button class="plus" data-a="add" data-r="${role}" data-k="${m.id}" aria-label="Agregar ${esc(m.nombre)}" ${m.disponible ? '' : 'disabled'}>+</button></div>`).join('')).join('');
}
function cartBox(role) {
  const c = ui.cart[role], t = cartTotal(c);
  if (!c.length) return `<div class="empty">Todavía no hay nada cargado.</div>`;
  const pts = role === 'cliente' ? estimate(t, c, S.saldo?.ganados) : 0;
  return c.map((l, i) => `<div class="line"><div class="sp">${esc(l.n)}${l.canje ? ` <span class="pill hop">−${l.canje} pts</span>` : ''}</div>
  <div class="qty">${l.canje ? `<button class="ghost" style="width:auto;padding:0 12px" data-a="qty" data-r="${role}" data-k="${i}" data-d="-1">Quitar</button>` : `<button data-a="qty" data-r="${role}" data-k="${i}" data-d="-1" aria-label="Quitar uno">−</button><span class="num">${l.q}</span><button data-a="qty" data-r="${role}" data-k="${i}" data-d="1" aria-label="Sumar uno">+</button>`}</div>
  <span class="num" style="width:90px;text-align:right">${money(l.p * l.q)}</span></div>`).join('') +
    `<div class="tot"><span>Total</span><span class="num">${money(t)}</span></div>
  ${pts ? `<p class="mute small">Suma cerca de <b class="num">${pts} puntos</b> al entregarse.</p>` : ''}
  <button class="pri" style="width:100%" data-a="send" data-r="${role}">${role === 'barra' ? 'Cargar pedido' : 'Enviar pedido a la barra'}</button><p class="small mute" style="margin:8px 0 0">Se cobra al entregar.</p>`;
}
function placePicker(role) {
  const sel = ui.f[role + 'L'], ab = abiertos();
  const btn = l => `<button class="${l.tipo === 'retira' ? 'wide' : ''}" data-a="lugar" data-r="${role}" data-k="${esc(l.nombre)}" aria-pressed="${sel === l.nombre}">${esc(l.tipo === 'mesa' ? l.nombre.replace(/^Mesa /, '') : l.nombre)}${l.tipo !== 'retira' && ab.some(o => o.lugar_id === l.id) ? '<i title="Con pedido abierto"></i>' : ''}</button>`;
  const L = activos();
  return `<div class="lbl">Mesas</div><div class="places">${L.filter(l => l.tipo === 'mesa').map(btn).join('')}</div>
 <div class="lbl">Barras y lugares de pie</div><div class="places">${L.filter(l => l.tipo !== 'mesa').map(btn).join('')}</div>
 <div class="grid2" style="margin-top:12px"><label>Nombre ${sel === 'Retira en barra' ? '(para llamarlo)' : '(opcional)'}<input data-f="${role}N" value="${esc(ui.f[role + 'N'] || '')}" autocomplete="off"></label>
 <label>Teléfono del cliente, si tiene cuenta<input data-f="${role}T" inputmode="tel" value="${esc(ui.f[role + 'T'] || '')}" autocomplete="off"></label></div>`;
}
function pickPlaces(sel) {
  const L = activos(), b = l => `<button class="${l.tipo === 'retira' ? 'wide' : ''}" data-a="clugar" data-k="${l.id}" aria-pressed="${String(sel) === String(l.id)}">${esc(l.tipo === 'mesa' ? l.nombre.replace(/^Mesa /, '') : l.tipo === 'retira' ? 'Retiro en la barra' : l.nombre)}</button>`;
  const r = L.find(l => l.tipo === 'retira');
  return `<div class="pick">${r ? `<div class="places" style="margin-bottom:10px">${b(r)}</div>` : ''}<div class="lbl">Mesas</div><div class="places">${L.filter(l => l.tipo === 'mesa').map(b).join('')}</div>
 <div class="lbl">Barras y lugares de pie</div><div class="places">${L.filter(l => l.tipo === 'barra').map(b).join('')}</div></div>`;
}
function glass(g) {
  const lv = levelOf(g), L = lvls(), next = L[L.indexOf(lv) + 1], base = lv.min, top = next ? next.min : base + 1;
  const f = next ? Math.max(.04, Math.min(1, (g - base) / (top - base))) : 1, h = 150 * f, y = 165 - h;
  return `<svg viewBox="0 0 130 180" role="img" aria-label="Vaso al ${Math.round(f * 100)}% del próximo nivel"><defs><clipPath id="cg"><path d="M18 12 L112 12 L100 168 L30 168 Z"/></clipPath>
 <linearGradient id="gb" x1="0" x2="1"><stop offset="0" stop-color="#c97a12"/><stop offset=".5" stop-color="#f0ac3c"/><stop offset="1" stop-color="#c97a12"/></linearGradient></defs>
 <g clip-path="url(#cg)"><rect width="130" height="180" fill="var(--amber2)"/><rect y="${y}" width="130" height="${h + 20}" fill="url(#gb)"/>
 <rect y="${y - 10}" width="130" height="14" rx="7" fill="#fff8ea"/><circle cx="50" cy="${Math.min(160, y + 40)}" r="3" fill="#ffd98a"/><circle cx="76" cy="${Math.min(160, y + 70)}" r="2.5" fill="#ffd98a"/></g>
 <path d="M18 12 L112 12 L100 168 L30 168 Z" fill="none" stroke="var(--ink)" stroke-width="3" stroke-linejoin="round"/><path d="M28 24 L37 156" stroke="#fff" stroke-opacity=".5" stroke-width="4" stroke-linecap="round"/></svg>`;
}
function rankTable(r) {
  if (!r.length) return '<div class="empty">Todavía no hay puntos este mes.</div>';
  return `<table class="stack"><thead><tr><th>#</th><th>Cliente</th><th class="r">Puntos del mes</th></tr></thead><tbody>${r.map(x => `<tr${x.soy_yo ? ' style="font-weight:700"' : ''}><td>${x.posicion}</td><td>${esc(x.nombre)}${x.soy_yo ? ' (vos)' : ''}</td><td class="r num">${x.puntos}</td></tr>`).join('')}</tbody></table>`;
}
function histRows(pedidos, ajustes, bonus) {
  const h = [];
  pedidos.forEach(o => {
    if (o.estado === 'entregado' && o.puntos) h.push({ ts: o.entregado_en, t: `Consumo ${money(o.total)} · pedido ${o.codigo}`, p: o.puntos });
    if (o.estado !== 'cancelado') o.pedido_items.filter(i => i.canje_puntos).forEach(i => h.push({ ts: o.creado, t: i.nombre, p: -i.canje_puntos * i.cantidad }));
  });
  ajustes.forEach(a => h.push({ ts: a.creado, t: 'Ajuste: ' + a.motivo, p: a.puntos }));
  h.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  if (bonus) h.unshift({ ts: null, t: 'Bonus por insignias ganadas', p: bonus });
  return h.length ? `<table class="hist"><tbody>${h.map(x => `<tr><td class="mute small num">${fecha(x.ts)}</td><td>${esc(x.t)}</td><td class="r num p ${x.p < 0 ? 'neg' : 'pos'}">${x.p > 0 ? '+' : ''}${x.p}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Sin movimientos todavía.</div>';
}
const abiertos = () => S.pedidos.filter(o => ['nuevo', 'prep', 'listo'].includes(o.estado));
const itemsTxt = o => o.pedido_items.map(i => i.cantidad + '× ' + esc(i.nombre)).join(', ');

/* ---------- vista cliente ---------- */
function trackCard(o) {
  const st = ['nuevo', 'prep', 'listo'], i = o.estado === 'entregado' ? 3 : st.indexOf(o.estado), l = lugarDe(o), r = l.tipo === 'retira';
  const msg = { nuevo: 'La barra recibió tu pedido.', prep: 'Lo están preparando.', listo: r ? 'Pasá a retirarlo por la barra.' : 'El mozo te lo lleva a ' + l.nombre + '.', entregado: 'Entregado. ¡Salud!' }[o.estado];
  return `<div class="card track${o.estado === 'listo' ? ' listo' : ''}" style="margin-bottom:10px"><div class="row"><div><div class="mute small">Pedido</div><div class="code">${esc(o.codigo)}</div></div><span class="sp"></span><span class="pill${o.estado === 'listo' ? ' hop' : ''}" style="font-size:16px;padding:4px 14px">${LBL[o.estado]}</span></div>
 <div class="steps">${[0, 1, 2].map(k => `<div class="${k < i ? 'on' : ''}${k === i && i < 3 ? ' on now' : ''}${i >= 2 ? ' done3' : ''}"></div>`).join('')}</div><div class="stepl"><span>Recibido</span><span>Preparando</span><span>Listo</span></div>
 <p style="margin:10px 0 4px"><b>${esc(msg)}</b></p><div class="small mute">${itemsTxt(o)} · ${money(o.total)} · ${esc(l.nombre)}</div></div>`;
}
function vCliente() {
  const p = S.perfil, sal = S.saldo || { ganados: 0, canjeados: 0, disponibles: 0 }, lv = levelOf(sal.ganados), L = lvls(), next = L[L.indexOf(lv) + 1];
  const lugar = lugarById(lsGet('lugar')), n = ui.cart.cliente.reduce((a, b) => a + b.q, 0);
  if (!lugar && !ui.pick) ui.pick = true;
  const act = S.pedidos.filter(o => ['nuevo', 'prep', 'listo'].includes(o.estado));
  const hoy = S.pedidos.filter(o => o.estado === 'entregado' && isToday(o.entregado_en)).slice(0, 3);
  const tabs = [['pedido', 'Pedido' + (act.length ? ' (' + act.length + ')' : '')], ['pedir', 'Pedir' + (n ? ' (' + n + ')' : '')], ['puntos', 'Puntos'], ['cuenta', 'Cuenta']];
  const head = `<div class="row"><div class="sp"><h2>Hola${p.nombre ? ', ' + esc(p.nombre.split(' ')[0]) : ''}</h2><span class="pill hop">${esc(lv.n)} · ${sal.disponibles} pts</span></div></div>
 <div class="chip" style="margin-top:12px">${lugar ? esc(lugar.tipo === 'retira' ? 'Retiro en la barra' : lugar.nombre) : '¿Dónde estás?'}<button data-a="pick">${ui.pick && lugar ? 'Cerrar' : 'Cambiar'}</button></div>
 ${ui.pick ? `<p class="mute small" style="margin:10px 0 0">Tocá dónde estás. Si estás parado, elegí "Retiro en la barra".</p>${pickPlaces(lsGet('lugar'))}` : ''}
 <div class="seg">${tabs.map(([k, t]) => `<button data-a="ct" data-k="${k}" aria-pressed="${ui.ct === k}">${t}</button>`).join('')}</div>`;
  let body = '';
  if (ui.ct === 'pedido') {
    const avisos = 'Notification' in window && Notification.permission === 'default';
    body = (act.length ? act.map(trackCard).join('') : `<div class="card empty">No tenés pedidos en curso. Pedile al mozo o en la barra, o tocá "Pedir".</div>`) +
      (avisos ? `<button class="ghost" style="width:100%;margin-top:10px" data-a="avisos">Activar avisos en este celular</button>` : '') +
      `<form id="f-code" class="card" style="margin-top:14px"><label>¿Pediste sin tu cuenta? Ingresá el código<div class="row" style="margin-top:6px;flex-wrap:nowrap"><input id="code" data-f="code" inputmode="numeric" maxlength="3" placeholder="427" value="${esc(ui.f.code || '')}"><button class="pri" type="submit">Seguir</button></div></label><p class="small mute" style="margin:6px 0 0">El pedido se suma a tu cuenta y te da puntos al entregarse.</p></form>` +
      (hoy.length ? `<h3 style="margin:22px 0 8px">Entregados hoy</h3>${hoy.map(o => `<div class="line"><b class="num">${esc(o.codigo)}</b><span class="sp small">${itemsTxt(o)}</span><span class="pill hop">+${o.puntos} pts</span></div>`).join('')}` : '');
  } else if (ui.ct === 'pedir') body = `${menuList('cliente')}<div class="card" style="margin-top:18px">${cartBox('cliente')}</div>`;
  else if (ui.ct === 'puntos') {
    const bonus = S.insignias.filter(b => b.ok).length * (cfg().bonus || 0);
    const pos = S.ranking.find(r => r.soy_yo);
    body = `<div class="card glass">${glass(sal.ganados)}<div><div class="big" style="font-size:52px">${sal.disponibles}<span style="font-size:22px"> pts</span></div>
  <div><b>Nivel ${esc(lv.n)}</b> · <span class="mute">${esc(lv.perk || '')}</span></div>
  <p class="small" style="margin:6px 0 0">${next ? `Te faltan <b class="num">${next.min - sal.ganados} pts</b> para ${esc(next.n)}.` : 'Llegaste al nivel más alto.'}</p></div></div>
  <div class="cat">Canjeá tus puntos</div>${cfg().rewards.map(r => `<div class="item"><div class="sp"><b>${esc(r.n)}</b><span class="mute small">${r.pts} puntos</span></div><button class="hop" data-a="redeem" data-k="${esc(r.id)}" ${sal.disponibles < r.pts ? 'disabled' : ''}>Canjear</button></div>`).join('') || '<div class="empty">Todavía no hay canjes.</div>'}
  <div class="cat">Insignias <span class="mute small">(+${cfg().bonus} pts cada una)</span></div><div class="badges">${S.insignias.map(b => { const d = BADGES[b.id] || { ic: '?', n: b.id, d: () => '' }; return `<div class="badge${b.ok ? ' ok' : ''}"><div class="ic">${d.ic}</div><b>${d.n}</b><div class="small mute">${esc(d.d(b.meta))}</div><div class="meter"><i style="width:${Math.min(1, b.valor / b.meta) * 100}%"></i></div><div class="small num">${Math.min(b.valor, b.meta)}/${b.meta}</div></div>`; }).join('')}</div>
  <div class="cat">Historial de puntos</div>${histRows(S.pedidos, S.ajustes, bonus)}
  <div class="cat">Ranking del mes</div>${pos ? `<p>Vas <b>${pos.posicion}º</b>. El primero del mes se lleva ${esc(cfg().premio)}.</p>` : '<p class="mute">Sumá tu primer consumo del mes para entrar al ranking.</p>'}${rankTable(S.ranking)}`;
  } else body = vCuenta();
  return `<div class="phone">${head}${body}</div>`;
}
function vCuenta() {
  const p = S.perfil;
  return `<form id="f-perfil" class="card" style="display:grid;gap:12px"><h3>Tus datos</h3>
  <label>Nombre<input id="pf-n" value="${esc(p.nombre)}" required autocomplete="name"></label>
  <label>Teléfono (opcional: el mozo te encuentra por acá)<input id="pf-t" inputmode="tel" value="${esc(p.telefono || '')}" autocomplete="tel"></label>
  <button class="pri" type="submit">Guardar</button><p class="small mute" style="margin:0">Cuenta: ${esc(S.user.email || '')}</p></form>
  ${passkeyOK() ? `<div class="card" style="margin-top:14px"><h3>Entrá con tu huella o tu cara</h3><p class="mute small">Tu celular verifica tu huella o tu cara. La app nunca la recibe ni la guarda.</p><button class="hop" data-a="pkreg">Activar en este celular</button></div>` : ''}
  <button class="ghost" style="width:100%;margin-top:14px" data-a="logout">Cerrar sesión</button>`;
}

/* ---------- vistas del personal ---------- */
function vMozo() {
  const listos = abiertos().filter(o => o.estado === 'listo' && lugarDe(o).tipo !== 'retira');
  return `<div class="two"><div><h2>Tomar pedido</h2>${placePicker('mozo')}${menuList('mozo')}</div>
 <div style="position:sticky;top:10px"><div class="card"><h3>${esc(ui.f.mozoL || 'Elegí el lugar')}</h3>${cartBox('mozo')}</div>
 <h3 style="margin:22px 0 8px">Listos para llevar</h3>${listos.length ? listos.map(o => `<div class="card row" style="margin-bottom:8px"><div class="sp"><b>${esc(lugarDe(o).nombre)}</b> <span class="mute small">${esc(o.codigo)} · ${ago(o.creado)}${o.nombre ? ' · ' + esc(o.nombre) : ''}</span><div class="small">${itemsTxt(o)}</div></div><button class="hop" data-a="adv" data-k="${o.id}">Entregar y cobrar ${money(o.total)}</button></div>`).join('') : '<div class="empty">Nada para llevar ahora.</div>'}</div></div>`;
}
function ticket(o) {
  const l = lugarDe(o), r = l.tipo === 'retira';
  return `<div class="ticket${r ? ' retira' : ''}"><div class="row"><span class="big">${esc(o.codigo)}</span><span class="big mute" style="font-size:22px">${r ? 'Retira' + (o.nombre ? ' · ' + esc(o.nombre) : '') : esc(l.nombre)}</span><span class="sp"></span><span class="pill">${{ cliente: 'App', mozo: 'Mozo', barra: 'Barra' }[o.origen]}</span></div>
 <div class="small mute">${ago(o.creado)}${!r && o.nombre ? ' · ' + esc(o.nombre) : ''}${r ? ' · llamar por el código' : ''}</div><ul>${o.pedido_items.map(i => `<li><b>${i.cantidad}×</b> ${esc(i.nombre)}</li>`).join('')}</ul>
 <div class="row"><button class="pri sp" data-a="adv" data-k="${o.id}">${o.estado === 'nuevo' ? 'Empezar' : o.estado === 'prep' ? 'Marcar listo' : 'Entregar y cobrar ' + money(o.total)}</button>${o.estado === 'nuevo' ? `<button class="ghost" data-a="cancel" data-k="${o.id}">Anular</button>` : ''}</div></div>`;
}
function vBarra() {
  const ab = abiertos(), col = e => ab.filter(o => o.estado === e);
  const ent = S.pedidos.filter(o => o.estado === 'entregado' && isToday(o.entregado_en)).sort((a, b) => new Date(b.entregado_en) - new Date(a.entregado_en));
  if (!ui.f.barraL) ui.f.barraL = 'Retira en barra';
  return `<div class="row" style="margin-bottom:14px"><h2 class="sp">Barra en vivo</h2><button class="${ui.nb ? 'pri' : ''}" data-a="nb">${ui.nb ? 'Cerrar pedido en barra' : 'Nuevo pedido en barra'}</button></div>
 ${ui.nb ? `<div class="two card" style="margin-bottom:20px"><div>${placePicker('barra')}${menuList('barra')}</div><div style="position:sticky;top:10px"><h3>${esc(ui.f.barraL)}</h3>${cartBox('barra')}</div></div>` : ''}
 <div class="rail">${[['nuevo', 'Nuevos'], ['prep', 'En preparación'], ['listo', 'Listos']].map(([e, t]) => { const l = col(e); return `<div class="col"><h3><span>${t}</span><span class="num">${l.length}</span></h3>${l.map(ticket).join('') || '<div class="empty">Vacío</div>'}</div>`; }).join('')}</div>
 <h2 style="margin:30px 0 10px">Entregados y cobrados hoy</h2>${ent.length ? `<table class="stack"><thead><tr><th>Código</th><th>Lugar</th><th>Cliente</th><th class="r">Total</th><th class="r">Puntos</th></tr></thead><tbody>${ent.slice(0, 20).map(o => `<tr><td><b>${esc(o.codigo)}</b></td><td>${esc(lugarDe(o).nombre)}</td><td>${esc(o.nombre) || '<span class="mute">Sin cuenta</span>'}</td><td class="r num">${money(o.total)}</td><td class="r num">${o.puntos}</td></tr>`).join('')}</tbody></table><p class="small mute">Total del día: <b class="num">${money(ent.reduce((x, o) => x + +o.total, 0))}</b></p>` : '<div class="empty">Todavía no se entregó nada hoy.</div>'}`;
}

/* ---------- administración ---------- */
function vAdmin() {
  const tabs = [['resumen', 'Resumen'], ['productos', 'Productos'], ['puntos', 'Sistema de puntos'], ['clientes', 'Clientes'], ['local', 'Local'], ['personal', 'Personal']];
  return `<div class="seg">${tabs.map(([k, t]) => `<button data-a="at" data-k="${k}" aria-pressed="${ui.at === k}">${t}</button>`).join('')}</div>` + ({ resumen: aResumen, productos: aProductos, puntos: aPuntos, clientes: aClientes, local: aLocal, personal: aPersonal }[ui.at])();
}
function aResumen() {
  const ent = S.pedidos.filter(o => o.estado === 'entregado' && isToday(o.entregado_en)), hoy = S.pedidos.filter(o => isToday(o.creado) && o.estado !== 'cancelado');
  const vend = ent.reduce((a, o) => a + +o.total, 0), top = {};
  hoy.forEach(o => o.pedido_items.forEach(i => { if (!i.canje_puntos) top[i.nombre] = (top[i.nombre] || 0) + i.cantidad; }));
  const tops = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 6), mx = tops.length ? tops[0][1] : 1;
  return `<h2>Cómo va el local hoy</h2>
 <div class="stat"><div class="card"><div class="mute small">Cobrado hoy</div><div class="big num">${money(vend)}</div></div>
 <div class="card"><div class="mute small">Pedidos de hoy</div><div class="big num">${hoy.length}</div></div>
 <div class="card"><div class="mute small">Ticket promedio</div><div class="big num">${ent.length ? money(vend / ent.length) : '—'}</div></div>
 <div class="card"><div class="mute small">Abiertos ahora</div><div class="big num">${abiertos().length}</div></div></div>
 <div class="two"><div><h3 style="margin-bottom:8px">Lo más pedido hoy</h3>${tops.map(([n, v]) => `<div style="margin-bottom:8px"><div class="row small"><span class="sp">${esc(n)}</span><span class="num">${v}</span></div><div class="meter" style="height:10px"><i style="width:${v / mx * 100}%;background:var(--amber)"></i></div></div>`).join('') || '<div class="empty">Sin pedidos todavía.</div>'}</div>
 <div><h3 style="margin-bottom:8px">Ranking del mes</h3>${rankTable(S.ranking)}</div></div>`;
}
function prodRow(m, isNew) {
  const id = isNew ? 'nuevo' : m.id, ck = (k, t) => `<label class="row small" style="font-weight:400"><input type="checkbox" data-k="${k}" ${m[k] ? 'checked' : ''}> ${t}</label>`;
  return `<tr data-row="${id}"><td><input data-k="nombre" value="${esc(m.nombre)}" placeholder="Nombre" aria-label="Nombre"><input data-k="descripcion" value="${esc(m.descripcion)}" placeholder="Descripción" aria-label="Descripción" style="margin-top:4px"></td>
 <td><input data-k="categoria" list="cats" value="${esc(m.categoria)}" aria-label="Categoría"></td><td><input data-k="precio" type="number" min="0" step="100" value="${+m.precio}" aria-label="Precio" style="width:110px"></td>
 <td><input data-k="puntos_extra" type="number" min="0" step="5" value="${m.puntos_extra || 0}" aria-label="Puntos extra" style="width:80px"></td>
 <td>${ck('es_cerveza', 'Cerveza')}${ck('es_picada', 'Picada')}${ck('disponible', 'Disponible')}</td>
 <td class="r"><div class="row" style="justify-content:flex-end"><button class="${isNew ? 'pri' : 'hop'}" data-a="psave" data-k="${id}">${isNew ? 'Crear' : 'Guardar'}</button>${isNew ? '' : `<button class="del" data-a="pdel" data-k="${id}">Borrar</button>`}</div></td></tr>`;
}
function aProductos() {
  return `<h2>Productos</h2><p class="mute">"Pts extra" se suma por unidad, además de los puntos por monto. "Cerveza" y "Picada" cuentan para las insignias.</p>
 <datalist id="cats">${cats().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
 <div class="scroll"><table class="ptab"><thead><tr><th>Producto</th><th>Categoría</th><th>Precio</th><th>Pts extra</th><th>Tipo</th><th></th></tr></thead><tbody>
 ${prodRow({ nombre: '', descripcion: '', categoria: cats()[0] || 'Cervezas', precio: 0, puntos_extra: 0, disponible: true }, true)}${S.productos.map(m => prodRow(m)).join('')}</tbody></table></div>`;
}
function aPuntos() {
  const c = ui.draft || cfg();
  return `<h2>Sistema de puntos</h2><p class="mute">Los cambios rigen desde que guardás. Lo ya entregado conserva los puntos que ganó.</p>
 <form id="f-sis" style="display:grid;gap:18px">
 <div class="card grid2"><label>Pesos por cada punto<input name="ppp" type="number" min="1" value="${c.ppp}"></label><label>Puntos por cada insignia<input name="bonus" type="number" min="0" value="${c.bonus}"></label><label>Premio del ranking mensual<input name="premio" value="${esc(c.premio)}"></label></div>
 <div class="card"><h3 style="margin-bottom:8px">Niveles</h3><div class="scroll"><table class="ptab"><thead><tr><th>Nombre</th><th>Desde (pts)</th><th>Multiplicador</th><th>Beneficio</th><th></th></tr></thead><tbody>
 ${c.levels.map((l, i) => `<tr data-lv="${i}"><td><input data-k="n" value="${esc(l.n)}"></td><td><input data-k="min" type="number" min="0" value="${l.min}" style="width:100px" ${i ? '' : 'readonly'}></td><td><input data-k="mult" type="number" min="1" step="0.1" value="${l.mult}" style="width:90px"></td><td><input data-k="perk" value="${esc(l.perk)}"></td><td>${i ? `<button class="del" type="button" data-a="lvdel" data-k="${i}">Quitar</button>` : ''}</td></tr>`).join('')}</tbody></table></div>
 <button type="button" class="ghost" data-a="lvadd" style="margin-top:8px">Agregar nivel</button></div>
 <div class="card"><h3 style="margin-bottom:8px">Canjes</h3><div class="scroll"><table class="ptab"><thead><tr><th>Premio</th><th>Puntos</th><th></th></tr></thead><tbody>
 ${c.rewards.map((r, i) => `<tr data-rw="${i}"><td><input data-k="n" value="${esc(r.n)}"></td><td><input data-k="pts" type="number" min="1" value="${r.pts}" style="width:110px"></td><td><button class="del" type="button" data-a="rwdel" data-k="${i}">Quitar</button></td></tr>`).join('')}</tbody></table></div>
 <button type="button" class="ghost" data-a="rwadd" style="margin-top:8px">Agregar canje</button></div>
 <div class="card"><h3 style="margin-bottom:8px">Insignias</h3><table class="ptab"><thead><tr><th>Activa</th><th>Insignia</th><th>Meta</th></tr></thead><tbody>
 ${Object.entries(BADGES).map(([id, b]) => { const x = c.badges[id] || { on: false, goal: 1 }; return `<tr data-bd="${id}"><td><input type="checkbox" data-k="on" ${x.on ? 'checked' : ''} aria-label="Activar ${b.n}"></td><td><b>${b.n}</b><div class="small mute">${esc(b.d('N'))}</div></td><td><input data-k="goal" type="number" min="1" value="${x.goal}" style="width:80px" aria-label="Meta de ${b.n}"></td></tr>`; }).join('')}</tbody></table></div>
 <div class="row"><button class="pri" type="submit">Guardar sistema de puntos</button>${ui.draft ? '<button type="button" class="ghost" data-a="sisdesc">Descartar cambios</button>' : ''}</div></form>`;
}
function readSis() {
  const f = $('#f-sis'), c = JSON.parse(JSON.stringify(ui.draft || cfg())), v = (el, k) => el.querySelector(`[data-k="${k}"]`);
  c.ppp = Math.max(1, +f.ppp.value || 100); c.bonus = Math.max(0, +f.bonus.value || 0); c.premio = f.premio.value.trim();
  c.levels = $$('[data-lv]').map(r => ({ n: v(r, 'n').value.trim() || 'Nivel', min: Math.max(0, +v(r, 'min').value || 0), mult: Math.max(1, +v(r, 'mult').value || 1), perk: v(r, 'perk').value.trim() }));
  c.levels[0].min = 0;
  c.rewards = $$('[data-rw]').map((r, i) => ({ id: (c.rewards[i] && c.rewards[i].id) || 'r-' + Date.now().toString(36) + i, n: v(r, 'n').value.trim() || 'Premio', pts: Math.max(1, +v(r, 'pts').value || 1) }));
  $$('[data-bd]').forEach(r => { c.badges[r.dataset.bd] = { on: v(r, 'on').checked, goal: Math.max(1, +v(r, 'goal').value || 1) }; });
  return c;
}
function aClientes() {
  if (!S.clientes) { loadClientes(); return '<div class="loading">Cargando clientes…</div>'; }
  const sel = ui.sel && S.clientes.find(c => c.id === ui.sel), lv = c => levelOf(c.ganados).n;
  return `<h2>Clientes</h2><div class="two"><div><input id="cq" placeholder="Buscar por nombre, email o teléfono" value="${esc(ui.q)}" aria-label="Buscar cliente" style="margin:12px 0">
 <table class="stack"><thead><tr><th>Cliente</th><th>Contacto</th><th>Nivel</th><th class="r">Disponibles</th><th></th></tr></thead><tbody>
 ${S.clientes.map(c => `<tr data-cli="${esc((c.nombre + ' ' + (c.email || '') + ' ' + (c.telefono || '')).toLowerCase())}"><td><b>${esc(c.nombre)}</b></td><td class="small">${esc(c.email || '')}<br>${esc(c.telefono || '')}</td><td>${esc(lv(c))}</td><td class="r num">${c.disponibles}</td><td class="r"><button class="${ui.sel === c.id ? 'pri' : 'ghost'}" data-a="sel" data-k="${c.id}">Ver</button></td></tr>`).join('')}</tbody></table>${S.clientes.length ? '' : '<div class="empty">Todavía no hay clientes.</div>'}</div>
 <div>${sel ? `<div class="card" style="position:sticky;top:10px"><h3>${esc(sel.nombre)}</h3><p class="mute small" style="margin:4px 0 12px">${esc(lv(sel))} · ganó ${sel.ganados} · canjeó ${sel.canjeados}</p>
 <div class="big" style="font-size:44px">${sel.disponibles} <span style="font-size:20px">pts disponibles</span></div>
 <form id="f-aj" class="grid2" style="margin:14px 0"><label>Puntos (negativo para restar)<input id="aj-p" type="number" required></label><label>Motivo<input id="aj-m" required placeholder="Cumpleaños, error de carga…"></label><button class="pri" type="submit">Aplicar ajuste</button></form>
 <h3 style="margin:10px 0 6px">Historial</h3>${S.hist ? histRows(S.hist.pedidos, S.hist.ajustes, 0) : '<div class="loading">Cargando…</div>'}</div>` : '<div class="empty">Elegí un cliente para ver su historial o ajustar sus puntos.</div>'}</div></div>`;
}
async function loadClientes() { const { data, error } = await sb.rpc('clientes_resumen'); if (error) return fail(error); S.clientes = data || []; render(true); }
async function loadHist(id) {
  S.hist = null; render(true);
  const [p, a] = await Promise.all([sb.from('pedidos').select(SEL).eq('cliente_id', id).order('creado', { ascending: false }).limit(100), sb.from('ajustes').select('*').eq('cliente_id', id)]);
  S.hist = { pedidos: p.data || [], ajustes: a.data || [] }; render(true);
}
function aLocal() {
  const link = l => BASE + '?lugar=' + l.id;
  return `<h2>Local</h2><form id="f-local" class="card row" style="max-width:720px;margin-bottom:18px"><label class="sp">Nombre del local<input name="local" value="${esc(cfg().local)}"></label><button class="pri" type="submit">Guardar</button></form>
 <h3 style="margin-bottom:6px">Lugares</h3><p class="mute small">Cada lugar tiene su link: imprimilo como QR en la mesa o la barra y el cliente entra con el lugar ya elegido.</p>
 <div class="scroll"><table class="ptab"><thead><tr><th>Nombre</th><th>Tipo</th><th>Orden</th><th>Activo</th><th>Link para el QR</th><th></th></tr></thead><tbody>
 ${[{ id: 'nuevo', nombre: '', tipo: 'mesa', orden: 0, activo: true }, ...S.lugares].map(l => `<tr data-lg="${l.id}"><td><input data-k="nombre" value="${esc(l.nombre)}" placeholder="Mesa 11" ${l.tipo === 'retira' ? 'readonly' : ''}></td>
 <td><select data-k="tipo" ${l.tipo === 'retira' ? 'disabled' : ''}>${['mesa', 'barra'].concat(l.tipo === 'retira' ? ['retira'] : []).map(t => `<option value="${t}" ${l.tipo === t ? 'selected' : ''}>${{ mesa: 'Mesa', barra: 'Barra / de pie', retira: 'Retira en barra' }[t]}</option>`).join('')}</select></td>
 <td><input data-k="orden" type="number" value="${l.orden}" style="width:80px"></td><td><input type="checkbox" data-k="activo" ${l.activo ? 'checked' : ''} aria-label="Activo"></td>
 <td>${l.id === 'nuevo' ? '' : `<button type="button" class="ghost" data-a="copy" data-k="${esc(link(l))}">Copiar link</button>`}</td>
 <td><button class="${l.id === 'nuevo' ? 'pri' : 'hop'}" data-a="lgsave" data-k="${l.id}">${l.id === 'nuevo' ? 'Agregar' : 'Guardar'}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function aPersonal() {
  return `<h2>Personal</h2><p class="mute">Cada persona del equipo entra con su propia cuenta (Google o email). Después la buscás por email y le asignás el rol.</p>
 <form id="f-rol" class="card grid2" style="max-width:720px;margin-bottom:18px"><label>Email de la persona<input id="rl-e" type="email" required></label>
 <label>Rol<select id="rl-r"><option value="mozo">Mozo</option><option value="barra">Barra</option><option value="admin">Administración</option><option value="cliente">Quitar acceso (cliente)</option></select></label><button class="pri" type="submit">Asignar</button></form>
 <table class="stack"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th></tr></thead><tbody>${S.personal.map(p => `<tr><td>${esc(p.nombre)}</td><td>${esc(p.email || '')}</td><td>${ROLES[p.rol]}</td></tr>`).join('')}</tbody></table>`;
}
async function loadPersonal() { const { data } = await sb.from('perfiles').select('id,nombre,email,rol').neq('rol', 'cliente').order('rol'); S.personal = data || []; render(true); }

/* ---------- render ---------- */
function render(force) {
  const a = document.activeElement;
  if (!force && a && a.closest && a.closest('#app') && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { pend = true; return; }
  pend = false;
  const V = { login: vLogin, cliente: vCliente, mozo: vMozo, barra: vBarra, admin: vAdmin };
  if (!ui.view || !V[ui.view]) return;
  $('#app').innerHTML = V[ui.view]();
  const r = S.perfil ? rol() : null;
  $('#nav').innerHTML = r && ACCESS[r].length > 1 ? ACCESS[r].map(v => `<a href="#${v}" aria-current="${ui.view === v ? 'page' : 'false'}">${ROLES[v]}</a>`).join('') : '';
  $('#who').innerHTML = r && r !== 'cliente' ? `<small>${esc(S.perfil.nombre)} · ${ROLES[r]}</small><button data-a="logout">Salir</button>` : '';
  if (ui.view === 'admin' && ui.at === 'clientes' && ui.q) $$('[data-cli]').forEach(x => x.style.display = x.dataset.cli.includes(ui.q.toLowerCase()) ? '' : 'none');
  setTimeout(checkReady, 0);
}
window.addEventListener('hashchange', () => {
  if (!S.perfil) return; const h = location.hash.slice(1);
  if (ACCESS[rol()].includes(h)) { ui.view = h; render(true); window.scrollTo(0, 0); }
});
setInterval(() => { if (ui.view === 'barra' || ui.view === 'mozo') render(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.user) scheduleReload(); });

/* ---------- eventos ---------- */
document.addEventListener('click', async e => {
  try { if (!actx && window.AudioContext) actx = new AudioContext(); if (actx && actx.state === 'suspended') actx.resume(); } catch {}
  const b = e.target.closest('[data-a]'); if (!b) return;
  const k = b.dataset.k, r = b.dataset.r;
  try {
    switch (b.dataset.a) {
      case 'auth': ui.auth = k; render(true); break;
      case 'oauth': { const { error } = await sb.auth.signInWithOAuth({ provider: k, options: { redirectTo: BASE } }); if (error) fail(error); break; }
      case 'pkin': { const { error } = await sb.auth.signInWithPasskey(); if (error) toast('No se pudo entrar con huella. Usá otra opción.'); break; }
      case 'pkreg': { const { error } = await sb.auth.registerPasskey(); if (error) fail(error); else toast('Listo: la próxima vez entrás con tu huella o tu cara'); break; }
      case 'olvide': {
        const em = ($('#se')?.value || '').trim(); if (!em) return toast('Escribí tu email arriba');
        const { error } = await sb.auth.resetPasswordForEmail(em, { redirectTo: BASE }); if (error) return fail(error);
        toast('Te mandamos un email para crear una contraseña nueva'); break;
      }
      case 'logout': await sb.auth.signOut(); ui.cart = { cliente: [], mozo: [], barra: [] }; ui.auth = 'inicio'; break;
      case 'add': add(r, k); break;
      case 'qty': qty(r, +k, +b.dataset.d); break;
      case 'send': await send(r); break;
      case 'ct': ui.ct = k; render(true); break;
      case 'at': ui.at = k; if (k === 'clientes') S.clientes = null; if (k === 'personal') loadPersonal(); render(true); break;
      case 'redeem': redeem(k); break;
      case 'lugar': ui.f[r + 'L'] = k; render(true); break;
      case 'clugar': { lsSet('lugar', +k); ui.pick = false; const { error } = await sb.rpc('cambiar_lugar', { p_lugar: +k }); if (error) fail(error); const l = lugarById(k); toast(l.tipo === 'retira' ? 'Retirás en la barra' : 'Te lo llevamos a ' + l.nombre); await loadAll(); render(true); break; }
      case 'pick': ui.pick = !ui.pick; render(true); break;
      case 'nb': ui.nb = !ui.nb; render(true); break;
      case 'adv': b.disabled = true; await advance(k); break;
      case 'cancel': await cancel(k); break;
      case 'rdok': $('#ready').hidden = true; checkReady(); break;
      case 'mdok': $('#modal').hidden = true; break;
      case 'avisos': if ('Notification' in window) { await Notification.requestPermission(); render(true); } break;
      case 'copy': try { await navigator.clipboard.writeText(k); toast('Link copiado'); } catch { prompt('Copiá el link:', k); } break;
      case 'sel': ui.sel = k; loadHist(k); break;
      case 'psave': {
        const row = b.closest('tr'), v = x => row.querySelector(`[data-k="${x}"]`), nombre = v('nombre').value.trim();
        if (!nombre) return toast('El producto necesita un nombre');
        const p = { nombre, descripcion: v('descripcion').value.trim(), categoria: v('categoria').value.trim() || 'Otros', precio: Math.max(0, Math.round(+v('precio').value || 0)), puntos_extra: Math.max(0, Math.round(+v('puntos_extra').value || 0)), es_cerveza: v('es_cerveza').checked, es_picada: v('es_picada').checked, disponible: v('disponible').checked };
        const q = k === 'nuevo' ? sb.from('productos').insert({ ...p, orden: S.productos.length + 1 }) : sb.from('productos').update(p).eq('id', k);
        const { error } = await q; if (error) return fail(error);
        toast(nombre + (k === 'nuevo' ? ' creado' : ' guardado')); await loadPublic(); render(true); break;
      }
      case 'pdel': {
        if (!b.dataset.c) { b.dataset.c = '1'; b.textContent = '¿Seguro?'; return; }
        const { error } = await sb.from('productos').delete().eq('id', k); if (error) return fail(error);
        toast('Producto borrado'); await loadPublic(); render(true); break;
      }
      case 'lgsave': {
        const row = b.closest('tr'), v = x => row.querySelector(`[data-k="${x}"]`), nombre = v('nombre').value.trim();
        if (!nombre) return toast('El lugar necesita un nombre');
        const p = { nombre, orden: +v('orden').value || 0, activo: v('activo').checked };
        if (!v('tipo').disabled) p.tipo = v('tipo').value;
        const { error } = k === 'nuevo' ? await sb.from('lugares').insert(p) : await sb.from('lugares').update(p).eq('id', +k);
        if (error) return fail(error); toast('Lugar guardado'); await loadPublic(); render(true); break;
      }
      case 'lvadd': { const c = readSis(), last = c.levels[c.levels.length - 1]; c.levels.push({ n: 'Nuevo nivel', min: (last ? last.min : 0) + 2000, mult: +((last ? last.mult : 1) + .2).toFixed(1), perk: '' }); ui.draft = c; render(true); break; }
      case 'lvdel': { const c = readSis(); c.levels.splice(+k, 1); ui.draft = c; render(true); break; }
      case 'rwadd': { const c = readSis(); c.rewards.push({ id: 'r-' + Date.now().toString(36), n: 'Nuevo premio', pts: 500 }); ui.draft = c; render(true); break; }
      case 'rwdel': { const c = readSis(); c.rewards.splice(+k, 1); ui.draft = c; render(true); break; }
      case 'sisdesc': ui.draft = null; render(true); break;
    }
  } catch (err) { fail(err); }
});

document.addEventListener('submit', async e => {
  e.preventDefault(); const id = e.target.id;
  try {
    if (id === 'f-mail') {
      ui.email = $('#em').value.trim();
      const { error } = await sb.auth.signInWithOtp({ email: ui.email, options: { shouldCreateUser: true, emailRedirectTo: BASE } });
      if (error) return fail(error); ui.auth = 'codigo'; render(true);
    }
    if (id === 'f-otp') { const { error } = await sb.auth.verifyOtp({ email: ui.email, token: $('#otp').value.trim(), type: 'email' }); if (error) fail(error); }
    if (id === 'f-staff') { ui.email = $('#se').value.trim(); const { error } = await sb.auth.signInWithPassword({ email: ui.email, password: $('#sp').value }); if (error) toast('Email o contraseña incorrectos'); }
    if (id === 'f-newpass') { const { error } = await sb.auth.updateUser({ password: $('#np').value }); if (error) return fail(error); toast('Contraseña actualizada'); ui.auth = 'inicio'; const { data } = await sb.auth.getSession(); lastUid = null; handleSession(data.session); }
    if (id === 'f-code') {
      const c = digits(ui.f.code); if (c.length !== 3) return toast('El código tiene 3 números');
      const { data, error } = await sb.rpc('vincular_pedido', { p_codigo: c }); if (error) return fail(error);
      const l = lugarById(lsGet('lugar')); if (l && l.id !== data.lugar_id) await sb.rpc('cambiar_lugar', { p_lugar: l.id });
      ui.f.code = ''; toast('Pedido ' + c + ' sumado a tu cuenta'); await loadAll(); render(true);
    }
    if (id === 'f-perfil') {
      const p = { nombre: $('#pf-n').value.trim(), telefono: digits($('#pf-t').value) || null };
      const { error } = await sb.from('perfiles').update(p).eq('id', S.user.id); if (error) return fail(error);
      Object.assign(S.perfil, p); toast('Datos guardados'); ui.ct = 'pedido'; render(true);
    }
    if (id === 'f-sis') {
      const c = readSis(); const { error } = await sb.from('config').update({ datos: c }).eq('id', 1); if (error) return fail(error);
      ui.draft = null; S.cfg = c; toast('Sistema de puntos guardado'); render(true);
    }
    if (id === 'f-local') {
      const c = { ...cfg(), local: e.target.local.value.trim() || 'Cervecería' };
      const { error } = await sb.from('config').update({ datos: c }).eq('id', 1); if (error) return fail(error);
      S.cfg = c; $('#brand').textContent = c.local; toast('Guardado'); render(true);
    }
    if (id === 'f-aj') {
      const p = Math.round(+$('#aj-p').value || 0), m = $('#aj-m').value.trim(); if (!p || !m) return toast('Indicá puntos y motivo');
      const { error } = await sb.rpc('ajustar_puntos', { p_cliente: ui.sel, p_puntos: p, p_motivo: m }); if (error) return fail(error);
      toast('Ajuste aplicado: ' + (p > 0 ? '+' : '') + p + ' pts'); const keep = ui.sel; S.clientes = null; await loadClientes(); ui.sel = keep; loadHist(keep);
    }
    if (id === 'f-rol') {
      const em = $('#rl-e').value.trim().toLowerCase(), nr = $('#rl-r').value;
      const { data } = await sb.from('perfiles').select('id,nombre').ilike('email', em).limit(1);
      if (!data?.[0]) return toast('No hay una cuenta con ese email. Primero tiene que entrar una vez a la app.');
      if (data[0].id === S.user.id && nr !== 'admin') return toast('No podés quitarte tu propio acceso de administración');
      const { error } = await sb.from('perfiles').update({ rol: nr }).eq('id', data[0].id); if (error) return fail(error);
      toast(data[0].nombre + ': ' + ROLES[nr]); loadPersonal();
    }
  } catch (err) { fail(err); }
});
document.addEventListener('input', e => {
  const t = e.target; if (t.dataset.f) ui.f[t.dataset.f] = t.value;
  if (t.id === 'cq') { ui.q = t.value; const q = t.value.toLowerCase(); $$('[data-cli]').forEach(r => r.style.display = r.dataset.cli.includes(q) ? '' : 'none'); }
});
document.addEventListener('focusout', () => setTimeout(() => { if (pend) render(); }, 300));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
