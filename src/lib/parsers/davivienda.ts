import { parseCOP, parseFechaDMY } from "@/lib/format";

export type FilaLeida = {
  fecha: string;
  doc: string | null;
  descripcion: string;
  valor: number;
};

export type ResultadoDavivienda = {
  tc: string | null;
  filas: FilaLeida[];
  textoCrudo: string;
};

const ROW_RE =
  /(\d{2}\/\d{2}\/\d{4})\s+(\d+)\s+(.+?)\s+\$?\s*(-?[\d.,]+)\s+(-?\d+)\s+(-?\d+)/;

export async function parseDaviviendaPdf(file: File): Promise<ResultadoDavivienda> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buffer }).promise;

  const lineas: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const porFila = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items as { str: string; transform: number[] }[]) {
      if (!("str" in item)) continue;
      const y = Math.round((item.transform[5] ?? 0) / 2) * 2;
      const arr = porFila.get(y) ?? [];
      arr.push({ x: item.transform[4] ?? 0, str: item.str });
      porFila.set(y, arr);
    }
    const ys = [...porFila.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const linea = (porFila.get(y) ?? [])
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (linea) lineas.push(linea);
    }
  }

  const texto = lineas.join("\n");
  const tcMatch = texto.match(/\*{3,}\s*(\d{4})/);

  const filas: FilaLeida[] = [];
  for (const linea of lineas) {
    const m = linea.match(ROW_RE);
    if (!m) continue;
    const fecha = parseFechaDMY(m[1] ?? "");
    const descripcion = (m[3] ?? "").replace(/\s+/g, " ").trim();
    if (!fecha || !descripcion) continue;
    filas.push({
      fecha,
      doc: m[2] ?? null,
      descripcion,
      valor: parseCOP(m[4] ?? "0"),
    });
  }

  return { tc: tcMatch?.[1] ?? null, filas, textoCrudo: texto };
}
