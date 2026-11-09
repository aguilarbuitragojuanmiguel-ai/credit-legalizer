import { formatFecha, hoyISO } from "@/lib/format";
import { claveTC, type Movimiento } from "@/lib/movimientos";

/** Último día del mes "2026-10" en ISO. */
export function finDeMesISO(periodo: string): string {
  const [a, m] = periodo.split("-").map(Number);
  return new Date(Date.UTC(a ?? 2000, m ?? 1, 0)).toISOString().slice(0, 10);
}

/**
 * Consumos que SIGUEN pendientes por legalizar hoy, con fecha de gasto hasta el fin
 * del mes elegido (el estado es el de hoy, no el de aquel cierre).
 */
export function pendientesAlCorte(movs: Movimiento[], periodo: string): Movimiento[] {
  const corte = finDeMesISO(periodo);
  return movs
    .filter((m) => m.tipo === "Consumo" && m.estado === "Pendiente" && m.fecha <= corte)
    .sort((a, b) => a.tc.localeCompare(b.tc) || a.fecha.localeCompare(b.fecha));
}

const dias = (a: string, b: string) =>
  Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

export async function exportarPendientesExcel(
  movs: Movimiento[],
  periodo: string,
  responsables: Record<string, string>,
) {
  const XLSX = await import("xlsx");
  const corte = finDeMesISO(periodo);
  const hoy = hoyISO();
  const lista = pendientesAlCorte(movs, periodo);

  const porTC = new Map<string, { banco: string; n: number; v: number; vieja: string }>();
  for (const m of lista) {
    const f = porTC.get(m.tc) ?? { banco: m.banco, n: 0, v: 0, vieja: m.fecha };
    f.n += 1;
    f.v += Number(m.valor);
    if (m.fecha < f.vieja) f.vieja = m.fecha;
    porTC.set(m.tc, f);
  }

  const resumen: (string | number)[][] = [
    [`PENDIENTES POR LEGALIZAR CON GASTOS HASTA ${formatFecha(corte)} (estado al ${formatFecha(hoy)})`],
    [],
    ["TC", "Banco", "Responsable", "# Pendientes", "Valor pendiente", "Gasto más antiguo", "Días de antigüedad (a hoy)"],
    ...[...porTC.entries()].map(([tc, f]) => [
      tc,
      f.banco,
      responsables[claveTC(tc)] ?? "",
      f.n,
      Math.round(f.v),
      formatFecha(f.vieja),
      dias(f.vieja, hoy),
    ]),
    [
      "TOTAL",
      "",
      "",
      lista.length,
      Math.round(lista.reduce((s, m) => s + Number(m.valor), 0)),
      "",
      "",
    ],
  ];

  const detalle: (string | number)[][] = [
    [
      "TC",
      "Banco",
      "Responsable",
      "Fecha gasto",
      "Doc",
      "Descripción",
      "Valor (COP)",
      "Moneda extracto",
      "Valor original",
      "TRM",
      "Días de antigüedad (a hoy)",
    ],
    ...lista.map((m) => [
      m.tc,
      m.banco,
      responsables[claveTC(m.tc)] ?? "",
      formatFecha(m.fecha),
      m.doc ?? "",
      m.descripcion,
      Math.round(Number(m.valor)),
      m.moneda || "COP",
      m.valor_original ?? "",
      m.trm ?? "",
      dias(m.fecha, hoy),
    ]),
  ];

  const wb = XLSX.utils.book_new();
  const h1 = XLSX.utils.aoa_to_sheet(resumen);
  h1["!cols"] = [{ wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 13 }, { wch: 16 }, { wch: 18 }, { wch: 20 }];
  const h2 = XLSX.utils.aoa_to_sheet(detalle);
  h2["!cols"] = [{ wch: 8 }, { wch: 13 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 40 }, { wch: 14 }, { wch: 15 }, { wch: 14 }, { wch: 10 }, { wch: 14 }];
  XLSX.utils.book_append_sheet(wb, h1, "Resumen");
  XLSX.utils.book_append_sheet(wb, h2, "Detalle");
  XLSX.writeFile(wb, `pendientes_por_legalizar_hasta_${periodo}.xlsx`);
  return lista.length;
}
