// Configuración de la conexión con Supabase.
// Supabase > Project Settings > API: copiá la "Project URL" y la clave "publishable" (o "anon").
// Estas dos son públicas y pueden ir en el repositorio: la seguridad la ponen las reglas de la base.
// NUNCA pongas acá la clave "service_role" / "secret" ni la contraseña de la base.

export const SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
export const SUPABASE_KEY = 'TU-CLAVE-PUBLISHABLE';

// Redes sociales activadas en Supabase > Authentication > Sign In / Providers.
// Dejá solo las que ya configuraste. Opciones: 'google', 'facebook', 'apple'
export const PROVIDERS = ['google'];

// Ingreso con huella o cara (passkeys). Activalo cuando lo habilites en
// Supabase > Authentication > Passkeys (es una función en beta).
export const PASSKEYS = false;
