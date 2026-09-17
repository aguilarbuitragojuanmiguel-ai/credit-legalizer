import { parseCOP, parseExcelDate } from "@/lib/format";

export type FilaBancolombia = {
  fecha: string;
  descripcion: string;
  valor: number;
};

export type ResultadoBancolombia = {
  tc: string | null;
  filas: FilaBancolombia[];
  ocrLineas: string[];
  imagenUrl: string | null;
  aviso: string | null;
};

function norm(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Descarta líneas de OCR que claramente no son descripciones de movimiento */
function limpiarLineasOcr(texto: string): string[] {
  return texto
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 3)
    .filter((l) => !/^[\d\s$.,/*|-]+$/.test(l))
    .filter((l) => !/^(fecha|valor|descripcion|descripción|movimientos?|tarjeta|saldo)\b/i.test(l));
}

export async function parseBancolombiaExcel(file: File): Promise<ResultadoBancolombia> {
  const XLSX = await import("xlsx");
  const JSZip = (await import("jszip")).default;

  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });

  let tc: string | null = null;
  const celdas: { fecha: string; valor: number }[] = [];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });

    let headerIdx = -1;
    let idxProducto = -1;
    let idxFecha = -1;
    let idxValor = -1;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const cells = row.map(norm);
      const fp = cells.findIndex((c) => c.includes("numero de producto"));
      const ff = cells.findIndex((c) => c === "fecha");
      const fv = cells.findIndex((c) => c === "valor");
      if (ff >= 0 && fv >= 0) {
        headerIdx = r;
        idxProducto = fp;
        idxFecha = ff;
        idxValor = fv;
        break;
      }
    }
    if (headerIdx < 0) continue;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const fecha = parseExcelDate(row[idxFecha]);
      const valor = parseCOP(row[idxValor] as string | number);
      if (!fecha || !valor) continue;
      if (!tc && idxProducto >= 0) {
        const m = String(row[idxProducto] ?? "").match(/(\d{3,4})\s*$/);
        if (m) tc = m[1] ?? null;
      }
      celdas.push({ fecha, valor });
    }
  }

  // Imagen embebida -> OCR (descripciones)
  let ocrLineas: string[] = [];
  let imagenUrl: string | null = null;
  let aviso: string | null = null;

  try {
    const zip = await JSZip.loadAsync(buffer);
    const media = Object.keys(zip.files).filter((n) => /^xl\/media\/.*\.(png|jpe?g)$/i.test(n));
    if (media.length === 0) {
      aviso = "El archivo no trae imagen embebida; escribe las descripciones a mano.";
    } else {
      const blobs = await Promise.all(
        media.map((n) => zip.files[n]!.async("blob").then((b) => ({ n, b }))),
      );
      blobs.sort((a, b) => b.b.size - a.b.size);
      const mayor = blobs[0]!;
      imagenUrl = URL.createObjectURL(mayor.b);
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("spa");
      const { data } = await worker.recognize(mayor.b);
      await worker.terminate();
      ocrLineas = limpiarLineasOcr(data.text || "");
      if (ocrLineas.length === 0) {
        aviso = "El OCR no pudo leer descripciones de la imagen; escríbelas a mano.";
      }
    }
  } catch {
    aviso = "No se pudo procesar la imagen del archivo; escribe las descripciones a mano.";
  }

  const filas: FilaBancolombia[] = celdas.map((c, i) => ({
    fecha: c.fecha,
    valor: c.valor,
    descripcion: ocrLineas[i] ?? "",
  }));

  return { tc, filas, ocrLineas, imagenUrl, aviso };
}
