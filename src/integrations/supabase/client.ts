import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "Faltan las variables de entorno VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. " +
      "Revisa tu archivo .env (local) o las variables de Cloudflare Pages (producción).",
  );
}

/**
 * Las API keys nuevas de Supabase (sb_publishable_..., sb_secret_...) NO son
 * JWT. supabase-js, por compatibilidad histórica, intenta reenviarlas también
 * como header "Authorization: Bearer <key>" — pero PostgREST/Storage esperan
 * un JWT ahí y rechazan la key nueva con "bad_jwt". Este wrapper elimina ese
 * header cuando la key es del formato nuevo, dejando solo "apikey" (que sí
 * es el mecanismo correcto para estas keys).
 */
function isNewSupabaseApiKey(value: string): boolean {
  return value.startsWith("sb_publishable_") || value.startsWith("sb_secret_");
}

function createSupabaseFetch(supabaseKey: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
    );
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    }
    if (
      isNewSupabaseApiKey(supabaseKey) &&
      headers.get("Authorization") === `Bearer ${supabaseKey}`
    ) {
      headers.delete("Authorization");
    }
    headers.set("apikey", supabaseKey);
    return fetch(input, { ...init, headers });
  };
}

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: createSupabaseFetch(SUPABASE_ANON_KEY) },
});
