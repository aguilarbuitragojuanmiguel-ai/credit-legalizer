import { supabase } from "@/integrations/supabase/client";

/**
 * Sube el Excel de legalización original a través de la Cloudflare Pages
 * Function (`functions/api/subir-legalizacion.ts`), que usa la service_role
 * key de Supabase para guardarlo en el bucket privado `legalizaciones` y
 * devuelve una URL firmada de larga duración para el link "Ver soporte".
 */
export async function subirArchivoLegalizacion(
  nombre: string,
  file: File,
): Promise<{ path: string; url: string }> {
  const { data: sesion } = await supabase.auth.getSession();
  const token = sesion.session?.access_token;
  if (!token) throw new Error("Sesión expirada. Vuelve a iniciar sesión.");
  const res = await fetch(`/api/subir-legalizacion?nombre=${encodeURIComponent(nombre)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Authorization: `Bearer ${token}`,
    },
    body: file,
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(detalle || "No se pudo subir el archivo");
  }
  return res.json();
}
