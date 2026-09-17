import { parseCOP } from "@/lib/format";

export type FilaBancolombiaPdf = {
  fecha: string;
  descripcion: string;
  /** Valor en la moneda original (COP o USD) */
  valor: number;
  moneda: "COP" | "USD";
};

export type ResultadoBancolombiaPdf = {
  tc: string | null;
  filas: FilaBancolombiaPdf[];
  textoCrudo: string;
};

const MESES: Record<string, string> = {
  ene: "01",
  feb: "02",
  mar: "03",
  abr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  ago: "08",
  sep: "09",
  set: "09",
  oct: "10",
  nov: "11",
  dic: "12",
};

function parseFechaEs(texto: string): string | null {
  const m = texto.match(/(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3,10})\.?\s+(\d{4})/);
  if (!m) return null;
  const mes = MESES[
    (m[2] ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .slice(0, 3)
  ];
  if (!mes) return null;
  return `${m[3]}-${mes}-${String(m[1]).padStart(2, "0")}`;
}

const FECHA_ES = String.raw`\d{1,2}\s+[A-Za-zÁÉÍÓÚáéíóú]{3,10}\.?\s+\d{4}`;
const reFilaFecha = new RegExp(
  String.raw`^(${FECHA_ES})\s+(?:--|${FECHA_ES})\s*(.*)$`,
  "i",
);
const reMonto = /(COP|USD)\s*\$\s*(-?[\d.,\s]+)$/i;
const reMontoSolo = /^(COP|USD)\s*\$\s*(-?[\d.,\s]+)$/i;
const rePlazo = /(-?\d{1,3})\s*$/;

/** El PDF de la Sucursal Virtual parte una misma transacción en varias líneas:
 *  la descripción se envuelve y a veces el valor queda en una línea aparte. */
function esRuido(linea: string): boolean {
  return (
    /svnegocios|bancolombia\.com|SVN - Bancolombia/i.test(linea) ||
    /^\d{1,2}\/\d{1,2}\/\d{2},/.test(linea) ||
    /^(Fecha de la|Descripción|transacción|facturación)/i.test(linea) ||
    /^Plazo\s*Valor$/i.test(linea) ||
    /^[\d\s]+$/.test(linea)
  );
}

function limpiarNumero(raw: string): string {
  // El PDF a veces separa los decimales con espacios: "7, 95" -> "7,95"
  return raw.replace(/([.,])\s+(\d)/g, "$1$2").trim();
}

/** Movimientos de la Sucursal Virtual Negocios impresos a PDF (texto seleccionable) */
export async function parseBancolombiaPdf(file: File): Promise<ResultadoBancolombiaPdf> {
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
      const y = Math.round((item.transform[5] ?? 0) / 3) * 3;
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
        // El PDF mete caracteres invisibles: espacios de ancho cero e íconos PUA
        .replace(/[\u200B\u200C\u200D\u2060\uFEFF\uE000-\uF8FF]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (linea) lineas.push(linea);
    }
  }

  const texto = lineas.join("\n");
  const tc = texto.match(/(?:visa|mastercard|master|amex)?\s*\*\s*(\d{4})/i)?.[1] ?? null;

  // Reagrupa líneas partidas: fragmentos de descripción y valores sueltos
  // se guardan y se pegan a la siguiente fila con fecha.
  const filas: FilaBancolombiaPdf[] = [];
  let bufferDesc: string[] = [];
  let bufferMonto: { valor: number; moneda: "COP" | "USD" } | null = null;

  for (const linea of lineas) {
    if (esRuido(linea)) continue;

    const mFecha = linea.match(reFilaFecha);
    if (mFecha) {
      const fecha = parseFechaEs(mFecha[1] ?? "");
      let resto = (mFecha[2] ?? "").trim();

      let valor = 0;
      let moneda: "COP" | "USD" = "COP";
      const mMonto = resto.match(reMonto);
      if (mMonto) {
        moneda = (mMonto[1] ?? "").toUpperCase() === "USD" ? "USD" : "COP";
        valor = parseCOP(limpiarNumero(mMonto[2] ?? "0"));
        resto = resto.slice(0, mMonto.index).trim();
      } else if (bufferMonto) {
        valor = bufferMonto.valor;
        moneda = bufferMonto.moneda;
        bufferMonto = null;
      }

      // Lo que queda: descripción + plazo al final
      const mPlazo = resto.match(rePlazo);
      if (mPlazo) resto = resto.slice(0, mPlazo.index).trim();

      // Antes de la primera fila real solo hay encabezados de la página: se botan
      const previos = filas.length > 0 ? bufferDesc : [];
      const descripcion = [...previos, resto]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      bufferDesc = [];

      if (fecha && descripcion && valor) {
        filas.push({ fecha, descripcion, valor, moneda });
      }
      continue;
    }

    const mSolo = linea.match(reMontoSolo);
    if (mSolo) {
      bufferMonto = {
        moneda: (mSolo[1] ?? "").toUpperCase() === "USD" ? "USD" : "COP",
        valor: parseCOP(limpiarNumero(mSolo[2] ?? "0")),
      };
      continue;
    }

    bufferDesc.push(linea);
  }

  return { tc, filas, textoCrudo: texto };
}
