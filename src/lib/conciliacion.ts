import type { CuentaTC, ExtractoGuardado, SaldoLibro } from "./conciliacion-db";
import { claveTC, type Movimiento } from "./movimientos";

/**
 * Conciliación mensual de una cuenta de TC (libros vs extracto).
 *
 *   Libros (deuda) = Extracto + Egresos pendientes por aplicar − Gastos del extracto sin contabilizar ± Diferencia
 *
 * - Egresos pendientes por aplicar: movimientos ya contabilizados (Legalizado / No deducible)
 *   que NO aparecen en las líneas del extracto (pasó el corte o el banco los cobra después).
 * - Gastos del extracto sin contabilizar: líneas del extracto que en la app siguen Pendientes
 *   o que no existen en la app.
 * - Diferencia: lo que no se explica con lo anterior (pagos en tránsito, notas, diferencia en cambio...).
 *
 * El cruce es línea por línea contra el PDF; la fecha de corte no decide nada por sí sola.
 */

export type ItemConciliacion = {
  fecha: string;
  descripcion: string;
  /** En pesos (para cuentas USD: valor en USD × TRM del día, igual que contabilidad) */
  valor: number;
  /** Valor en la moneda del extracto (USD o COP) */
  valorMoneda: number;
  movId: string | null;
  nota?: string;
};

export type ResultadoCuenta = {
  cuenta: CuentaTC;
  periodo: string;
  libros: number | null;
  extracto: ExtractoGuardado | null;
  /** Saldo del extracto en pesos (USD convertido con la TRM del corte) */
  saldoExtractoPesos: number | null;
  saldoExtractoMoneda: number | null;
  trmCorte: number | null;
  conciliados: number;
  /** Egresos pendientes por aplicar (en libros, no en extracto) */
  pendientesPorAplicar: ItemConciliacion[];
  /** Gastos del extracto aún sin contabilizar (Pendientes en la app) */
  sinContabilizar: ItemConciliacion[];
  /** Líneas del extracto sin movimiento en la app */
  sinMovimientoApp: ItemConciliacion[];
  totalPendientes: number;
  totalSinContabilizar: number;
  /** libros − (extracto + pendientes − sin contabilizar) */
  diferencia: number | null;
  estado: "cuadra" | "diferencia" | "sin_datos";
  avisos: string[];
};

const TOL_PESOS = 1;

function norm(t: string): string {
  return t
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function puntajeDescripcion(a: string, b: string): number {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y || x.includes(y) || y.includes(x)) return 3;
  const ta = new Set(x.split(" "));
  return y.split(" ").some((w) => w.length > 2 && ta.has(w)) ? 1 : 0;
}

function dias(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function finDeMes(periodo: string): string {
  const [a, m] = periodo.split("-").map(Number);
  return new Date(Date.UTC(a ?? 2000, m ?? 1, 0)).toISOString().slice(0, 10);
}

const contabilizado = (m: Movimiento) =>
  m.estado === "Legalizado" || m.estado === "No deducible" || m.estado === "N/A";

const r2 = (n: number) => Math.round(n * 100) / 100;

export function conciliarCuenta(args: {
  cuenta: CuentaTC;
  periodo: string;
  libros: SaldoLibro[];
  extractos: ExtractoGuardado[];
  movs: Movimiento[];
  /** TRM por fecha ISO (solo cuentas USD) */
  trm: Record<string, number | null>;
}): ResultadoCuenta {
  const { cuenta, periodo, movs } = args;
  const avisos: string[] = [];
  const claves = new Set([claveTC(cuenta.tc), claveTC(cuenta.tc_alias ?? "")].filter(Boolean));

  const saldo = args.libros.find((l) => l.periodo === periodo && l.cuenta === cuenta.cuenta);
  const libros = saldo ? 0 - saldo.saldo_final : null;

  const inicioMes = `${periodo}-01`;
  const finMes = finDeMes(periodo);
  const extracto =
    args.extractos
      .filter(
        (e) =>
          claves.has(claveTC(e.tc)) &&
          e.moneda === cuenta.moneda &&
          e.fecha_corte >= inicioMes &&
          e.fecha_corte <= finMes,
      )
      .sort((a, b) => b.fecha_corte.localeCompare(a.fecha_corte))[0] ?? null;
  return construir(cuenta, periodo, libros, extracto, claves, movs, args.trm, avisos, finMes);
}

function construir(
  cuenta: CuentaTC,
  periodo: string,
  libros: number | null,
  extracto: ExtractoGuardado | null,
  claves: Set<string>,
  movs: Movimiento[],
  trm: Record<string, number | null>,
  avisos: string[],
  finMes: string,
): ResultadoCuenta {
  const vacio: ResultadoCuenta = {
    cuenta,
    periodo,
    libros,
    extracto,
    saldoExtractoPesos: null,
    saldoExtractoMoneda: null,
    trmCorte: null,
    conciliados: 0,
    pendientesPorAplicar: [],
    sinContabilizar: [],
    sinMovimientoApp: [],
    totalPendientes: 0,
    totalSinContabilizar: 0,
    diferencia: null,
    estado: "sin_datos",
    avisos,
  };
  if (libros === null) avisos.push("Falta el saldo de libros de este período (sube el balance).");
  if (!extracto) {
    avisos.push("Falta el extracto de este período para esta cuenta.");
    return vacio;
  }

  const esUSD = cuenta.moneda === "USD";
  const saldoMoneda = r2(extracto.saldo_total - (extracto.resumen?.saldoAFavor ?? 0));
  let trmCorte: number | null = null;
  let saldoPesos: number | null = saldoMoneda;
  if (esUSD) {
    trmCorte = trm[extracto.fecha_corte] ?? null;
    if (Math.abs(saldoMoneda) < 1) {
      saldoPesos = 0; // polvo de centavos en dólares
    } else if (trmCorte) {
      saldoPesos = Math.round(saldoMoneda * trmCorte);
    } else {
      saldoPesos = null;
      avisos.push("No pude traer la TRM del corte: el saldo en USD no se pudo pasar a pesos.");
    }
  }

  // Movimientos de la app de esta cuenta (misma TC y misma moneda).
  // Para cruzar se mira un poco antes del período (el banco a veces carga después);
  // para las partidas por aplicar solo cuenta lo dentro del período facturado.
  const inicioPeriodo = extracto.periodo_desde ?? `${periodo}-01`;
  const desde = sumarDias(inicioPeriodo, -20);
  const candidatos = movs.filter(
    (m) =>
      m.tipo === "Consumo" &&
      claves.has(claveTC(m.tc)) &&
      (m.moneda || "COP") === cuenta.moneda &&
      m.fecha >= desde &&
      m.fecha <= finMes,
  );

  const compras = extracto.lineas.filter((l) => l.tipo === "compra");

  const pares: { i: number; m: Movimiento; puntaje: number }[] = [];
  compras.forEach((l, i) => {
    for (const m of candidatos) {
      const valorOk = esUSD
        ? m.valor_original != null && Math.abs(Number(m.valor_original) - l.valor) <= 0.011
        : Math.abs(Number(m.valor) - l.valor) < 2;
      if (!valorOk) continue;
      const d = dias(l.fecha, m.fecha);
      if (d > 12) continue;
      const pf = d === 0 ? 3 : d <= 3 ? 2 : 1;
      pares.push({ i, m, puntaje: pf + puntajeDescripcion(l.descripcion, m.descripcion) });
    }
  });
  pares.sort((a, b) => b.puntaje - a.puntaje);
  const usadoLinea = new Set<number>();
  const usadoMov = new Set<string>();
  const asignado = new Map<number, Movimiento>();
  for (const p of pares) {
    if (usadoLinea.has(p.i) || usadoMov.has(p.m.id)) continue;
    usadoLinea.add(p.i);
    usadoMov.add(p.m.id);
    asignado.set(p.i, p.m);
  }

  const pesosLinea = (valor: number, fecha: string): number => {
    if (!esUSD) return valor;
    const t = trm[fecha] ?? trmCorte;
    return t ? Math.round(valor * t) : 0;
  };

  let conciliados = 0;
  const sinContabilizar: ItemConciliacion[] = [];
  const sinMovimientoApp: ItemConciliacion[] = [];
  compras.forEach((l, i) => {
    const m = asignado.get(i);
    if (m && contabilizado(m)) {
      conciliados += 1;
    } else if (m) {
      sinContabilizar.push({
        fecha: l.fecha,
        descripcion: l.descripcion,
        valor: Number(m.valor),
        valorMoneda: l.valor,
        movId: m.id,
        nota: "Sigue Pendiente en la app",
      });
    } else {
      const v = pesosLinea(l.valor, l.fecha);
      sinMovimientoApp.push({
        fecha: l.fecha,
        descripcion: l.descripcion,
        valor: v,
        valorMoneda: l.valor,
        movId: null,
        nota: "Está en el extracto pero no en la app",
      });
    }
  });

  const pendientesPorAplicar: ItemConciliacion[] = candidatos
    .filter(
      (m) =>
        !usadoMov.has(m.id) && contabilizado(m) && m.estado !== "N/A" && m.fecha >= inicioPeriodo,
    )
    .map((m) => ({
      fecha: m.fecha,
      descripcion: m.descripcion,
      valor: Number(m.valor),
      valorMoneda: esUSD ? Number(m.valor_original ?? 0) : Number(m.valor),
      movId: m.id,
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const totalPendientes = pendientesPorAplicar.reduce((s, x) => s + x.valor, 0);
  const totalSinContabilizar =
    sinContabilizar.reduce((s, x) => s + x.valor, 0) +
    sinMovimientoApp.reduce((s, x) => s + x.valor, 0);

  const diferencia =
    libros === null || saldoPesos === null
      ? null
      : r2(libros - (saldoPesos + totalPendientes - totalSinContabilizar));

  if (sinMovimientoApp.length > 0)
    avisos.push(
      `${sinMovimientoApp.length} línea(s) del extracto no tienen movimiento en la app: sube los movimientos o revísalas.`,
    );
  if (esUSD && Math.abs(saldoMoneda) >= 1)
    avisos.push("Saldo en USD distinto de 0: la diferencia puede incluir diferencia en cambio.");

  return {
    cuenta,
    periodo,
    libros,
    extracto,
    saldoExtractoPesos: saldoPesos,
    saldoExtractoMoneda: saldoMoneda,
    trmCorte,
    conciliados,
    pendientesPorAplicar,
    sinContabilizar,
    sinMovimientoApp,
    totalPendientes: r2(totalPendientes),
    totalSinContabilizar: r2(totalSinContabilizar),
    diferencia,
    estado: diferencia === null ? "sin_datos" : Math.abs(diferencia) <= TOL_PESOS ? "cuadra" : "diferencia",
    avisos,
  };
}
