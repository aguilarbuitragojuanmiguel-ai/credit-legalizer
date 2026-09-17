import { parseCOP, parseExcelDate } from "@/lib/format";

export type GastoLegalizado = {
  hoja: string;
  tc: string | null;
  fecha: string;
  proveedor: string;
  valor: number;
};

function norm(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export async function parseLegalizacionExcel(file: File): Promise<GastoLegalizado[]> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array", cellDates: true });

  const gastos: GastoLegalizado[] = [];

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
    // Normaliza filas: los arreglos de xlsx pueden traer huecos (undefined)
    const rows: string[][] = raw.map((row) =>
      Array.from({ length: Array.isArray(row) ? row.length : 0 }, (_, i) =>
        String((row as unknown[])[i] ?? ""),
      ),
    );

    // TC desde la fila que contenga "Responsable"
    let tc: string | null = null;
    for (const cells of rows) {
      if (!cells.some((c) => norm(c).includes("responsable"))) continue;
      const m = cells.join(" ").match(/TC\s*[.:#-]?\s*(\d{3,5})/i);
      if (m) {
        tc = m[1] ?? null;
        break;
      }
    }
    // Fallback: busca "TC ####" en cualquier celda de la parte superior
    if (!tc) {
      for (const cells of rows.slice(0, 25)) {
        const m = cells.join(" ").match(/TC\s*[.:#-]?\s*(\d{3,5})/i);
        if (m) {
          tc = m[1] ?? null;
          break;
        }
      }
    }

    // Fila de encabezados real: debe tener "fecha" y además "proveedor" o una columna de total
    let headerIdx = -1;
    let idxFecha = -1;
    let idxProveedor = -1;
    let idxTotal = -1;
    for (let r = 0; r < rows.length; r++) {
      const cells = (rows[r] ?? []).map(norm);
      const f = cells.findIndex((c) => c === "fecha" || /^fecha\b/.test(c));
      if (f < 0) continue;
      // Descarta filas de cabecera del reembolso tipo "Fechas Reembolso:"
      if ((cells[f] ?? "").includes(":")) continue;

      const prov = cells.findIndex((c) => c.includes("proveedor"));
      let total = cells.findIndex((c) => c.includes("total pagado"));
      if (total < 0) total = cells.findIndex((c) => c.includes("total") && !c.includes("gasto"));
      if (total < 0) total = cells.findIndex((c) => c.includes("valor unitario"));
      if (total < 0) total = cells.findIndex((c) => c.includes("valor"));
      if (prov < 0 && total < 0) continue;

      headerIdx = r;
      idxFecha = f;
      idxProveedor = prov;
      idxTotal = total;
      break;
    }
    if (headerIdx < 0 || idxTotal < 0) continue;

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] ?? [];
      const rowRaw = (Array.isArray(raw[r]) ? (raw[r] as unknown[]) : []) as unknown[];
      const fecha = parseExcelDate(idxFecha >= 0 ? rowRaw[idxFecha] : null);
      const valor = parseCOP(rowRaw[idxTotal] as string | number);
      if (!fecha || !(valor > 0)) continue;
      const proveedor =
        idxProveedor >= 0 ? String(row[idxProveedor] ?? "").replace(/\s+/g, " ").trim() : "";
      if (norm(proveedor).includes("saldo mes anterior")) continue;
      gastos.push({ hoja: name, tc, fecha, proveedor, valor });
    }
  }

  return gastos;
}
