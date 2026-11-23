// Configuración de la conexión con Supabase.
// Supabase > botón "Connect" (o Settings > API Keys): Project URL y clave "publishable".
// Estas dos son públicas y pueden ir en el repositorio: la seguridad la ponen las reglas de la base.
// NUNCA pongas acá la clave "secret" (sb_secret_...) ni la contraseña de la base.

export const SUPABASE_URL = 'https://prnrrnythbhbqdwdbaim.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_Q9InQTf_8X8h-cVC_Z3Ykw_Z6mTWy4m';

// Redes sociales activadas en Supabase > Authentication > Sign In / Providers.
// Dejá solo las que ya configuraste. Opciones: 'google', 'facebook', 'apple'
export const PROVIDERS = ['google'];

// Ingreso con huella o cara (passkeys). Activalo cuando lo habilites en
// Supabase > Authentication > Passkeys (es una función en beta).
export const PASSKEYS = false;
