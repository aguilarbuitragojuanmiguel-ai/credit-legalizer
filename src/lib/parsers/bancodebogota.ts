import { parseExcelDate } from "@/lib/format";

export type FilaBancoBogota = {
  fecha: string;
  doc: string | null;
  descripcion: string;
  valor: number;
};

export type ResultadoBancoBogota = {
  tc: string | null;
  filas: FilaBancoBogota[];
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

/** El nombre del archivo que exporta Banco de Bogotá es el número de la TC (ej. "9958.xlsx") */
function tcDesdeNombreArchivo(nombre: string): string | null {
  const base = nombre.replace(/\.[^.]+$/, "").trim();
  const m = base.match(/(\d{3,6})/);
  return m ? m[1]! : null;
}

export async function parseBancoBogotaExcel(file: File): Promise<ResultadoBancoBogota> {
  const XLSX = await import("xlsx");

  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });

  const filas: FilaBancoBogota[] = [];
  const monedasRaras = new Set<string>();

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true });

    let headerIdx = -1;
    let idxFecha = -1;
    let idxDoc = -1;
    let idxDescripcion = -1;
    let idxMoneda = -1;
    let idxValor = -1;

    for (let r = 0; r < rows.length; r++) {
      const cells = (rows[r] ?? []).map(norm);
      const ff = cells.findIndex((c) => c.startsWith("fecha"));
      const fd = cells.findIndex((c) => c.startsWith("descripcion"));
      const fv = cells.findIndex((c) => c.startsWith("valor"));
      if (ff >= 0 && fd >= 0 && fv >= 0) {
        headerIdx = r;
        idxFecha = ff;
        idxDescripcion = fd;
        idxValor = fv;
        idxDoc = cells.findIndex((c) => c.includes("autorizacion"));
        idxMoneda = cells.findIndex((c) => c.includes("moneda"));
        break;
      }
    }
    if (headerIdx < 0) continue;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const fecha = parseExcelDate(row[idxFecha]);
      const valorRaw = row[idxValor];
      if (!fecha || typeof valorRaw !== "number") continue;
      const descripcion = String(row[idxDescripcion] ?? "").replace(/\s+/g, " ").trim();
      if (!descripcion) continue;
      const doc = idxDoc >= 0 && row[idxDoc] != null ? String(row[idxDoc]).trim() : null;
      const moneda = idxMoneda >= 0 ? String(row[idxMoneda] ?? "").trim().toUpperCase() : "COP";
      if (moneda && moneda !== "COP") monedasRaras.add(moneda);
      filas.push({ fecha, doc: doc || null, descripcion, valor: valorRaw });
    }
  }

  return {
    tc: tcDesdeNombreArchivo(file.name),
    filas,
    aviso:
      monedasRaras.size > 0
        ? `Algunas filas vienen en ${[...monedasRaras].join(", ")} y no en COP: revisa esos valores a mano, no se convirtieron.`
        : null,
  };
}
