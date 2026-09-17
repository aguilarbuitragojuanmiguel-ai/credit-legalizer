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
  const res = await fetch(`/api/subir-legalizacion?nombre=${encodeURIComponent(nombre)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => "");
    throw new Error(detalle || "No se pudo subir el archivo");
  }
  return res.json();
}
