export function formatCOP(value: number): string {
  const n = Math.round(Number(value) || 0);
  return `$ ${n.toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/** Parses Colombian formatted numbers: "$ 1.234.567,89" -> 1234567.89 */
export function parseCOP(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return raw;
  if (!raw) return 0;
  let s = String(raw).trim();
  const negative = s.includes("-") || /^\(.*\)$/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if ((s.match(/\./g) || []).length >= 1 && /\.\d{3}(\D|$)/.test(s + " ")) {
    s = s.replace(/\./g, "");
  }
  const n = parseFloat(s);
  if (Number.isNaN(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

/** "21/08/2026" -> "2026-08-21" */
export function parseFechaDMY(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return null;
  const d = m[1] ?? "";
  const mo = m[2] ?? "";
  const y = m[3] ?? "";
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/** 20260821 (number or string) -> "2026-08-21" */
export function parseFechaCompact(raw: string | number): string | null {
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return parseFechaDMY(s);
}

/** Excel serial or text/date cell -> ISO date */
export function parseExcelDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const d = value;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }
  if (typeof value === "number") {
    if (value > 19000000) return parseFechaCompact(value);
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  return parseFechaCompact(String(value));
}

export const PALABRAS_BANCARIAS = [
  "IMP 4XMIL",
  "4X1000",
  "PAGO",
  "CRU SALDO FAVOR",
  "ABONO SUCURSAL VIRTUAL",
  "DEV COMI",
];

export type Tipo = "Consumo" | "Movimiento Bancario";
export type Estado = "Pendiente" | "Legalizado" | "N/A";

export function clasificar(descripcion: string): Tipo {
  const d = (descripcion || "").toUpperCase();
  return PALABRAS_BANCARIAS.some((p) => d.includes(p)) ? "Movimiento Bancario" : "Consumo";
}

export function estadoInicial(tipo: Tipo): Estado {
  return tipo === "Movimiento Bancario" ? "N/A" : "Pendiente";
}

export function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function formatFecha(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}
