/**
 * Cloudflare Pages Function.
 * Recibe el binario del Excel de legalización (?nombre=... en la query,
 * el archivo crudo como body) y lo guarda en el bucket privado
 * `legalizaciones` de Supabase usando la service_role key (nunca expuesta
 * al navegador). Devuelve { path, url } con una URL firmada de 5 años.
 *
 * Variables de entorno que hay que configurar en Cloudflare Pages
 * (Settings > Environment variables) — NO en el .env del frontend:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const nombreParam = url.searchParams.get("nombre");
  if (!nombreParam) {
    return new Response("Falta el parámetro 'nombre'", { status: 400 });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(
      "Faltan las variables de entorno SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en Cloudflare Pages",
      { status: 500 },
    );
  }

  const binary = await request.arrayBuffer();
  if (binary.byteLength === 0) {
    return new Response("Archivo vacío", { status: 400 });
  }

  const path = `${Date.now()}_${nombreParam.replace(/[^\w.\-]+/g, "_")}`;

  // Nota: las secret keys nuevas de Supabase (sb_secret_...) no son JWT.
  // Van en el header "apikey" — NO en "Authorization: Bearer", que Storage
  // intenta validar como JWT y rechaza con error.
  const uploadRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/legalizaciones/${path}`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      body: binary,
    },
  );
  if (!uploadRes.ok) {
    return new Response(`No se pudo guardar el archivo: ${await uploadRes.text()}`, {
      status: 500,
    });
  }

  const signRes = await fetch(
    `${env.SUPABASE_URL}/storage/v1/object/sign/legalizaciones/${path}`,
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 365 * 5 }),
    },
  );
  if (!signRes.ok) {
    return new Response(`No se pudo generar el enlace: ${await signRes.text()}`, {
      status: 500,
    });
  }
  const signed = (await signRes.json()) as { signedURL: string };

  return Response.json({
    path,
    url: `${env.SUPABASE_URL}/storage/v1${signed.signedURL}`,
  });
};
