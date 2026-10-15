import { parseCOP } from "../format";

export type ItemTexto = { str: string; x: number; y: number };

export type FilaActa = {
  tc: string | null;
  /** Fecha tal como aparece en el acta (puede venir mal escrita) */
  fechaTexto: string;
  /** Fecha ISO normalizada, o null si no se pudo interpretar */
  fecha: string | null;
  /** true si hubo que corregirla (ej. 31/06 -> 30/06) */
  fechaAjustada: boolean;
  descripcion: string;
  valor: number;
};

export type ResultadoActa = {
  titulo: string;
  /** "2026-T2" si el título cubre un solo trimestre */
  periodoSugerido: string | null;
  filas: FilaActa[];
};

const FECHA_RE = /^(\d{1,2})\/(\d{1,3})\/(\d{4})$/;
const VALOR_RE = /^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/;
const TC_RE = /^TC\s*(\d{3,6})\b/i;

const MESES = [
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
];

/** "6/005/2026" -> 2026-05-06 ; "31/06/2026" -> 2026-06-30 (ajustada) ; "x" -> null */
export function normalizarFechaActa(texto: string): { fecha: string | null; ajustada: boolean } {
  const m = texto.trim().match(FECHA_RE);
  if (!m) return { fecha: null, ajustada: false };
  const dia = parseInt(m[1] ?? "", 10);
  const mes = parseInt(m[2] ?? "", 10);
  const anio = parseInt(m[3] ?? "", 10);
  if (!(mes >= 1 && mes <= 12) || !(dia >= 1)) return { fecha: null, ajustada: false };
  const ultimo = new Date(anio, mes, 0).getDate();
  const d = Math.min(dia, ultimo);
  return {
    fecha: `${anio}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    ajustada: dia > ultimo,
  };
}

function periodoDesdeTitulo(titulo: string): string | null {
  const t = titulo
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const anio = t.match(/\b(20\d{2})\b/)?.[1];
  if (!anio) return null;
  const encontrados: number[] = [];
  for (const palabra of t.split(/[^A-Z]+/)) {
    const idx = MESES.indexOf(palabra);
    if (idx >= 0) encontrados.push(idx + 1);
  }
  if (encontrados.length === 0) return null;
  const tri = (m: number) => Math.ceil(m / 3);
  const primero = tri(encontrados[0] ?? 1);
  const ultimo = tri(encontrados[encontrados.length - 1] ?? 1);
  return primero === ultimo ? `${anio}-T${primero}` : null;
}

function agruparLineas(items: ItemTexto[]): ItemTexto[][] {
  const orden = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lineas: ItemTexto[][] = [];
  let yActual = Number.POSITIVE_INFINITY;
  for (const it of orden) {
    if (lineas.length === 0 || Math.abs(it.y - yActual) > 2.5) {
      lineas.push([it]);
      yActual = it.y;
    } else {
      lineas[lineas.length - 1]?.push(it);
    }
  }
  return lineas.map((l) => l.sort((a, b) => a.x - b.x));
}

/** Parte pura (sin pdf.js): recibe los textos con posición de cada página. */
export function parseActaItems(paginas: { items: ItemTexto[]; ancho: number }[]): ResultadoActa {
  const filas: FilaActa[] = [];
  let titulo = "";
  let tcActual: string | null = null;

  for (const pag of paginas) {
    const items = pag.items.filter((i) => i.str.trim() !== "");

    if (!titulo) {
      for (const linea of agruparLineas(items)) {
        const txt = linea.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
        if (/DEDUCIBLE|RELACION|GASTOS/i.test(txt) && !FECHA_RE.test(linea[0]?.str ?? "")) {
          titulo = txt;
          break;
        }
      }
    }

    const corte = pag.ancho / 2;
    for (const col of [0, 1]) {
      const delaColumna = items.filter((i) => (i.x < corte ? 0 : 1) === col);
      for (const linea of agruparLineas(delaColumna)) {
        const txt = linea.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
        if (!txt) continue;
        const tcM = txt.match(TC_RE);
        if (tcM) {
          tcActual = tcM[1] ?? null;
          continue;
        }
        if (/^(TOTAL|SALDO)/i.test(txt)) continue;

        const primero = linea[0]?.str.trim() ?? "";
        const ultimo = linea[linea.length - 1]?.str.trim() ?? "";
        if (!FECHA_RE.test(primero) || !VALOR_RE.test(ultimo) || linea.length < 2) continue;

        const descripcion = linea
          .slice(1, -1)
          .map((i) => i.str.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const { fecha, ajustada } = normalizarFechaActa(primero);
        filas.push({
          tc: tcActual,
          fechaTexto: primero,
          fecha,
          fechaAjustada: ajustada,
          descripcion: descripcion || "(sin descripción)",
          valor: parseCOP(ultimo),
        });
      }
    }
  }

  return { titulo, periodoSugerido: periodoDesdeTitulo(titulo), filas };
}

/** Lee un acta en PDF (formato "Relación gastos no deducibles") en el navegador. */
export async function parseActaFiscalPDF(file: File): Promise<ResultadoActa> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const paginas: { items: ItemTexto[]; ancho: number }[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: ItemTexto[] = [];
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (typeof it.str !== "string" || !it.transform) continue;
      items.push({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0 });
    }
    paginas.push({ items, ancho: page.view[2] ?? 612 });
  }
  return parseActaItems(paginas);
}
