# Cervecería · pedidos, seguimiento y puntos

App web instalable en el celular (PWA) para una cervecería:

- **Cliente:** entra con Google, Facebook, Apple o un código por email. Elige con botones dónde está (mesa, barra o "retiro en la barra"). Sigue su pedido con el código de 3 cifras. Cuando está listo recibe un aviso animado. También pide, canjea puntos y ve su historial, sus insignias y el ranking.
- **Mozo:** toma pedidos por lugar y entrega y cobra lo que está listo.
- **Barra:** ve los pedidos en vivo (nuevos, en preparación, listos), carga pedidos en el mostrador y entrega y cobra.
- **Administración:** ve el resumen del día y administra productos, sistema de puntos (valor del punto, niveles, canjes, insignias), clientes (historial y ajuste de puntos), lugares con su link para QR y personal con sus roles.

El cobro se hace **al entregar**: en ese momento se acreditan los puntos.

## Cómo está armada

| Parte | Qué hace |
|---|---|
| `index.html`, `styles.css`, `app.js` | La app. Es HTML y JavaScript, sin compilar. |
| `config.js` | La conexión con tu proyecto de Supabase. **Es lo único que tenés que editar.** |
| `sw.js`, `manifest.webmanifest`, `icons/` | Permiten instalarla en el celular como una app. |
| `supabase/01_estructura.sql` | Tablas, seguridad por rol y lógica de pedidos y puntos. |
| `supabase/02_ranking_insignias.sql` | Insignias, ranking mensual y listado de clientes. |

Toda la lógica que toca plata o puntos corre **en la base**, no en el celular: precios, códigos, canjes y puntos al entregar. Cada rol solo puede leer y hacer lo suyo. Por eso la clave publishable puede estar en el repositorio sin riesgo.

## Puesta en marcha

### 1. Base de datos (Supabase)
1. En **SQL Editor → New query**, corré `supabase/01_estructura.sql`. Si ya lo corriste, saltealo.
2. En otra query, corré `supabase/02_ranking_insignias.sql`.
3. Tu usuario administrador: entrá una vez a la app (paso 4) o creá el usuario en **Authentication → Users**. Después corré:
   ```sql
   update public.perfiles set rol = 'admin'
   where id = (select id from auth.users where email = 'TU_EMAIL');
   ```

### 2. Conexión
En **Project Settings → API**, copiá la *Project URL* y la clave *publishable* (o *anon*) en `config.js`.
Nunca pongas la clave `service_role` / `secret`.

### 3. Publicar con GitHub Pages
1. Subí todos los archivos a un repositorio, por ejemplo `cerveceria`.
2. En **Settings → Pages → Build and deployment**, elegí *Deploy from a branch*, rama `main`, carpeta `/ (root)`.
3. La app queda en `https://TU-USUARIO.github.io/cerveceria/`.

### 4. Direcciones permitidas para el ingreso
- **Supabase → Authentication → URL Configuration**
  - *Site URL:* `https://TU-USUARIO.github.io/cerveceria/`
  - *Redirect URLs:* agregá `https://TU-USUARIO.github.io/cerveceria/**`
- **Google Cloud → Google Auth Platform → Clients → tu cliente web**
  - *Authorized JavaScript origins:* `https://TU-USUARIO.github.io`
  - *Authorized redirect URIs:* la Callback URL que muestra Supabase en el proveedor Google.

### 5. Ingreso por email con código
En **Authentication → Emails → Magic Link**, agregá `{{ .Token }}` a la plantilla para que el email traiga el código de 6 dígitos además del link.
El envío de emails incluido en Supabase tiene límites bajos y sirve para probar. Antes de abrir, configurá un servidor de email propio en **Authentication → Emails → SMTP Settings**.

### 6. Personal
Cada persona del equipo entra una vez a la app con su cuenta. Después, en **Administración → Personal**, la buscás por email y le asignás el rol: mozo, barra o administración.
Si alguien entra con email y contraseña y la olvida, en "Soy del personal → Olvidé mi contraseña" recibe un link para crear una nueva.

### 7. QR de mesas y barras
En **Administración → Local**, cada lugar tiene su link (`…/?lugar=ID`). Pasalo a un generador de QR e imprimilo. El cliente que lo escanea entra con el lugar ya elegido.

### 8. Huella o cara (passkeys, opcional)
1. **Supabase → Authentication → Passkeys:** activalas y completá:
   - *Relying Party ID:* `TU-USUARIO.github.io`, o tu dominio si después usás uno propio;
   - *Relying Party Origins:* `https://TU-USUARIO.github.io`.
2. En `config.js`, poné `PASSKEYS = true`.
3. El cliente las activa desde **Cuenta → Activar en este celular**.

La huella o la cara nunca salen del celular: la app solo recibe una firma digital.
Ojo: si cambiás el Relying Party ID, las passkeys ya creadas dejan de servir. Definilo antes de abrir.

## Pendiente para una segunda etapa
- **Avisos con el celular bloqueado** (notificaciones push): hoy el aviso de "listo" aparece cuando la app está abierta o en segundo plano.
- **Dominio propio**, para la app y para la pantalla de ingreso de Google.
- **Facebook y Apple:** se activan en Supabase igual que Google y se agregan a `PROVIDERS` en `config.js`.
