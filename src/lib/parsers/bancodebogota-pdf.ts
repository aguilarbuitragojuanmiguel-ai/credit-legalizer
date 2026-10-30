import { parseFechaDMY } from "@/lib/format";

import type { FilaBancoBogota, ResultadoBancoBogota } from "./bancodebogota";

/**
 * Banco de Bogotá en PDF (la lista de gastos que sale de Excel):
 *   Fecha Actividad | Descripción | Valor de la compra | Tasa | Plazo
 *   21/10/2026 GMF CONSUMO $19,493.45 2.12
 * Los valores vienen en formato inglés (coma = miles, punto = decimales).
 */
const FILA_RE =
  /^(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+\$\s*(-?[\d,]+(?:\.\d+)?)(?:\s+-?[\d.]+)?(?:\s+-?\d+)?$/;

/** El archivo trae la TC en el nombre (ej. "TC_3691.pdf") o en el título de la hoja. */
function tcDesde(nombre: string, texto: string): string | null {
  const base = nombre.replace(/\.[^.]+$/, "");
  const m = base.match(/(\d{4})(?!.*\d{4})/);
  if (m) return m[1]!;
  const t = texto.match(/\bTC\s*(\d{4})\b/i);
  return t ? t[1]! : null;
}

export function parseBancoBogotaLineas(lineas: string[], nombreArchivo: string): ResultadoBancoBogota {
  const filas: FilaBancoBogota[] = [];
  for (const linea of lineas) {
    const m = linea.match(FILA_RE);
    if (!m) continue;
    const fecha = parseFechaDMY(m[1] ?? "");
    const descripcion = (m[2] ?? "").replace(/\s+/g, " ").trim();
    const valor = parseFloat((m[3] ?? "").replace(/,/g, ""));
    if (!fecha || !descripcion || !Number.isFinite(valor)) continue;
    filas.push({ fecha, doc: null, descripcion, valor });
  }
  return { tc: tcDesde(nombreArchivo, lineas.join("\n")), filas, aviso: null };
}

export async function parseBancoBogotaPdf(file: File): Promise<ResultadoBancoBogota> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lineas: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const porFila = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items as { str: string; transform: number[] }[]) {
      if (!("str" in item)) continue;
      const y = Math.round((item.transform[5] ?? 0) / 2) * 2;
      const arr = porFila.get(y) ?? [];
      arr.push({ x: item.transform[4] ?? 0, str: item.str });
      porFila.set(y, arr);
    }
    for (const y of [...porFila.keys()].sort((a, b) => b - a)) {
      const linea = (porFila.get(y) ?? [])
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (linea) lineas.push(linea);
    }
  }
  return parseBancoBogotaLineas(lineas, file.name);
}
