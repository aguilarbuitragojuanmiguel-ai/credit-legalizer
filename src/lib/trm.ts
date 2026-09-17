/** TRM oficial (Superfinanciera) vía datos.gov.co, con caché por fecha. */

const cache = new Map<string, number | null>();

export async function fetchTRM(fechaISO: string): Promise<number | null> {
  const cached = cache.get(fechaISO);
  if (cached !== undefined) return cached;
  try {
    const url =
      "https://www.datos.gov.co/resource/32sa-8pi3.json" +
      `?$where=vigenciadesde<='${fechaISO}T00:00:00'` +
      "&$order=vigenciadesde DESC&$limit=1";
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { valor?: string }[];
    const valor = Number(String(data[0]?.valor ?? "").replace(",", "."));
    const trm = Number.isFinite(valor) && valor > 0 ? valor : null;
    cache.set(fechaISO, trm);
    return trm;
  } catch {
    cache.set(fechaISO, null);
    return null;
  }
}
