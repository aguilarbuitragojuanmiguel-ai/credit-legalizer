/**
 * Lee el "Libro Mayor y Balance" (Excel) y se queda solo con las cuentas de
 * tarjetas de crédito: 8 dígitos que empiezan por 21053 (la 210530 es el total
 * y no se cuenta).
 */

export type CuentaBalance = {
  cuenta: string;
  descripcion: string;
  saldoAnterior: number;
  debitos: number;
  creditos: number;
  /** Nuevo saldo = saldo anterior + débitos − créditos (negativo = deuda) */
  saldoFinal: number;
};

export type ResultadoBalance = {
  /** "2026-09" */
  periodo: string | null;
  /** ISO de la fecha de corte del balance */
  fechaCorte: string | null;
  empresa: string | null;
  cuentas: CuentaBalance[];
};

const PREFIJO_TC = "21053";

function aNumero(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function parseBalanceRows(rows: unknown[][]): ResultadoBalance {
  let fechaCorte: string | null = null;
  let empresa: string | null = null;
  const cuentas: CuentaBalance[] = [];

  for (const row of rows) {
    const a = String(row[0] ?? "").trim();
    const b = String(row[1] ?? "").trim();

    if (!empresa && b && /\bSAS\b|S\.A\.S|LTDA|S\.A\./i.test(b) && cuentas.length === 0) {
      empresa = b;
    }
    const corte = a.match(/Fecha Corte:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i);
    if (corte) {
      // Formato del reporte: M/D/YYYY
      fechaCorte = `${corte[3]}-${String(corte[1]).padStart(2, "0")}-${String(corte[2]).padStart(2, "0")}`;
    }

    if (a.length === 8 && a.startsWith(PREFIJO_TC) && /^\d+$/.test(a)) {
      cuentas.push({
        cuenta: a,
        descripcion: b,
        saldoAnterior: aNumero(row[2]),
        debitos: aNumero(row[3]),
        creditos: aNumero(row[4]),
        saldoFinal: aNumero(row[5]),
      });
    }
  }

  return {
    periodo: fechaCorte ? fechaCorte.slice(0, 7) : null,
    fechaCorte,
    empresa,
    cuentas,
  };
}

/** Lee el Excel del balance en el navegador. */
export async function parseBalanceExcel(file: File): Promise<ResultadoBalance> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const hoja = wb.Sheets[wb.SheetNames[0] ?? ""];
  if (!hoja) return { periodo: null, fechaCorte: null, empresa: null, cuentas: [] };
  const rows = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: null });
  return parseBalanceRows(rows);
}
