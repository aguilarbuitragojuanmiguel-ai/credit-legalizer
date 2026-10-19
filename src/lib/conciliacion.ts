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
  /** Estado del movimiento en la app (Legalizado, Pendiente, ...) */
  estado?: string;
  /** true = suma al cuadre (ya está contabilizado) */
  suma?: boolean;
  /** legalizado / pendiente / bancario (nota o pago de la app) / extracto (línea del PDF) */
  grupo?: "legalizado" | "pendiente" | "bancario" | "pago" | "extracto";
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
  /** Cargos bancarios y abonos del extracto que sí cruzan con la app */
  conciliadosBancarios: number;
  /** Pistas: partidas que explican justo la diferencia */
  pistas: string[];
  /** Egresos pendientes por aplicar (en libros, no en extracto) */
  pendientesPorAplicar: ItemConciliacion[];
  /** Todo lo que está en la app y no en el extracto (legalizado o pendiente), con nota del estado */
  enAppSinExtracto: ItemConciliacion[];
  /** Gastos del extracto aún sin contabilizar (Pendientes en la app) */
  sinContabilizar: ItemConciliacion[];
  /** Líneas del extracto sin movimiento en la app */
  sinMovimientoApp: ItemConciliacion[];
  totalPendientes: number;
  totalSinContabilizar: number;
  /** Pagos a la TC que están en libros y todavía no en el extracto (restan) */
  totalPagosTransito: number;
  /** libros − (extracto + pendientes − sin contabilizar − pagos en tránsito) */
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
  /** Fecha desde la que la app tiene movimientos (lo anterior ya estaba en libros) */
  inicioApp?: string;
}): ResultadoCuenta {
  const { cuenta, periodo, movs } = args;
  const inicioApp = args.inicioApp ?? "2026-09-01";
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
  return construir(cuenta, periodo, libros, extracto, claves, movs, args.trm, avisos, finMes, inicioApp);
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
  inicioApp: string,
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
    conciliadosBancarios: 0,
    pistas: [],
    pendientesPorAplicar: [],
    enAppSinExtracto: [],
    sinContabilizar: [],
    sinMovimientoApp: [],
    totalPendientes: 0,
    totalSinContabilizar: 0,
    totalPagosTransito: 0,
    diferencia: null,
    estado: "sin_datos",
    avisos,
  };
  if (libros === null) avisos.push("Falta el saldo de libros de este período (sube el balance).");
  if (libros !== null && libros < 0)
    avisos.push(
      "El balance trae esta tarjeta con saldo DEUDOR (positivo): una TC debería quedar con saldo en contra (negativo). Revisa si algún movimiento se contabilizó con el signo invertido o si hay un sobrepago.",
    );
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

  // Movimientos de la app de esta cuenta (misma TC y misma moneda), de cualquier tipo:
  // compras, cargos bancarios y abonos. No dependemos de la etiqueta Consumo / Movimiento Bancario.
  // Para cruzar se mira un poco antes del período (el banco a veces carga después);
  // para las partidas por aplicar solo cuenta lo dentro del período facturado.
  const inicioPeriodo = extracto.periodo_desde ?? `${periodo}-01`;
  const desde = sumarDias(inicioPeriodo, -20);
  const candidatos = movs.filter(
    (m) =>
      claves.has(claveTC(m.tc)) &&
      (m.moneda || "COP") === cuenta.moneda &&
      m.fecha >= desde &&
      m.fecha <= finMes,
  );
  const esBancarioApp = (m: Movimiento) => m.tipo === "Movimiento Bancario";

  const lineas = extracto.lineas;

  const pares: { i: number; m: Movimiento; puntaje: number }[] = [];
  lineas.forEach((l, i) => {
    for (const m of candidatos) {
      const vApp = Math.abs(esUSD ? Number(m.valor_original ?? Number.NaN) : Number(m.valor));
      const vExt = Math.abs(l.valor);
      const valorOk = esUSD ? Math.abs(vApp - vExt) <= 0.011 : Math.abs(vApp - vExt) < 2;
      if (!valorOk) continue;
      const d = dias(l.fecha, m.fecha);
      if (d > 12) continue;
      const pf = d === 0 ? 3 : d <= 3 ? 2 : 1;
      const compat = (l.tipo === "compra") === !esBancarioApp(m) ? 1 : 0;
      pares.push({ i, m, puntaje: pf + puntajeDescripcion(l.descripcion, m.descripcion) + compat });
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
  let conciliadosBancarios = 0;
  const sinContabilizar: ItemConciliacion[] = [];
  const sinMovimientoApp: ItemConciliacion[] = [];
  lineas.forEach((l, i) => {
    const m = asignado.get(i);
    const bancariaExt = l.tipo !== "compra";
    if (m) {
      if (bancariaExt) {
        conciliadosBancarios += 1;
      } else if (contabilizado(m) || m.estado === "Pendiente") {
        // Pendiente de legalizar también está en libros (cuenta de ajuste): cuenta como cruzado
        conciliados += 1;
      } else {
        sinContabilizar.push({
          fecha: l.fecha,
          descripcion: l.descripcion,
          valor: Number(m.valor),
          valorMoneda: l.valor,
          movId: m.id,
          nota: "Sigue Pendiente en la app",
          grupo: "pendiente",
        });
      }
    } else if (bancariaExt) {
      // Cargo bancario o abono del extracto sin movimiento en la app: se informa,
      // no suma al cuadre (se asume contabilizado).
      sinMovimientoApp.push({
        fecha: l.fecha,
        descripcion: l.descripcion,
        valor: pesosLinea(l.valor, l.fecha),
        valorMoneda: l.valor,
        movId: null,
        nota:
          l.tipo === "abono"
            ? "Abono del extracto sin movimiento en la app (no suma al cuadre)"
            : "Cargo bancario del extracto sin movimiento en la app (no suma al cuadre)",
        suma: false,
        grupo: "extracto",
      });
    } else {
      sinMovimientoApp.push({
        fecha: l.fecha,
        descripcion: l.descripcion,
        valor: pesosLinea(l.valor, l.fecha),
        valorMoneda: l.valor,
        movId: null,
        nota:
          l.fecha < inicioApp
            ? "Anterior al inicio de la app: ya estaba en libros, no suma al cuadre"
            : "Está en el extracto pero no en la app",
        suma: l.fecha >= inicioApp,
        grupo: "extracto",
      });
    }
  });

  // Lo que está en la app y no en el extracto
  const sobrantes = candidatos.filter((m) => !usadoMov.has(m.id) && m.fecha >= inicioPeriodo);
  const esPagoApp = (m: Movimiento) =>
    esBancarioApp(m) && /\b(PAGO|ABONO)\b/i.test(m.descripcion);
  const aItem = (m: Movimiento): ItemConciliacion => {
    const pago = esPagoApp(m);
    // 4x1000 / GMF: el extracto los agrupa en una sola línea hasta el corte;
    // los posteriores al corte ya están en libros y no en el extracto → suman.
    const gmf = !pago && esBancarioApp(m) && /4\s*X\s*1000|4\s*X\s*MIL|\bGMF\b/i.test(m.descripcion);
    const gmfDespuesCorte = gmf && m.fecha > extracto.fecha_corte;
    const bancario = !pago && !gmfDespuesCorte && (esBancarioApp(m) || m.estado === "N/A");
    const suma = !pago && !bancario;
    return {
      fecha: m.fecha,
      descripcion: m.descripcion,
      valor: Math.abs(Number(m.valor)),
      valorMoneda: esUSD ? Math.abs(Number(m.valor_original ?? 0)) : Math.abs(Number(m.valor)),
      movId: m.id,
      estado: m.estado,
      suma,
      grupo: pago ? "pago" : bancario ? "bancario" : "legalizado",
      nota: pago
        ? "Pago a la tarjeta en la app, aún no está en el extracto (resta al cuadre)"
        : bancario
          ? gmf
            ? "4x1000 hasta el corte: el extracto lo agrupa en la línea GMF (no suma)"
            : esBancarioApp(m)
            ? "Nota bancaria de la app, no está en el extracto (no suma al cuadre)"
            : "Marcado N/A (no suma al cuadre)"
          : suma
            ? gmfDespuesCorte
              ? "4x1000 posterior al corte: ya está en libros, no en el extracto (suma al cuadre)"
              : m.estado === "Pendiente"
              ? "Pendiente de legalizar (ya está en libros como pendiente: suma al cuadre)"
              : `Ya está ${m.estado === "No deducible" ? "legalizado (no deducible)" : "legalizado"}`
            : "",
    };
  };
  const enAppSinExtracto = sobrantes
    .map(aItem)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  const pendientesPorAplicar = enAppSinExtracto.filter((i) => i.grupo === "legalizado");
  const pagosTransito = enAppSinExtracto.filter((i) => i.grupo === "pago");

  const totalPendientes = pendientesPorAplicar.reduce((s, x) => s + x.valor, 0);
  const totalPagosTransito = pagosTransito.reduce((s, x) => s + x.valor, 0);
  const totalSinContabilizar =
    sinContabilizar.reduce((s, x) => s + x.valor, 0) +
    sinMovimientoApp.filter((x) => x.suma).reduce((s, x) => s + x.valor, 0);

  const diferencia =
    libros === null || saldoPesos === null
      ? null
      : r2(libros - (saldoPesos + totalPendientes - totalSinContabilizar - totalPagosTransito));

  // Pistas: ¿alguna nota, pago o cargo bancario explica justo la diferencia?
  const pistas: string[] = [];
  if (diferencia !== null && Math.abs(diferencia) > TOL_PESOS) {
    const cand: { etiqueta: string; valor: number }[] = [];
    for (const i of enAppSinExtracto.filter((x) => x.grupo === "bancario"))
      cand.push({ etiqueta: `${i.descripcion} (${i.fecha}) · en la app, no en el extracto`, valor: i.valor });
    for (const i of sinMovimientoApp.filter((x) => !x.suma))
      cand.push({ etiqueta: `${i.descripcion} (${i.fecha}) · en el extracto, no en la app`, valor: i.valor });
    const sumaBanc = enAppSinExtracto
      .filter((x) => x.grupo === "bancario")
      .reduce((s, x) => s + Math.abs(x.valor), 0);
    if (sumaBanc > 0) cand.push({ etiqueta: "todas las notas y pagos bancarios de la app sin extracto", valor: sumaBanc });
    const sumaExt = sinMovimientoApp
      .filter((x) => !x.suma)
      .reduce((s, x) => s + Math.abs(x.valor), 0);
    if (sumaExt > 0) cand.push({ etiqueta: "todos los cargos/abonos del extracto sin movimiento en la app", valor: sumaExt });
    for (const c of cand) {
      if (Math.abs(Math.abs(diferencia) - Math.abs(c.valor)) <= 1.5)
        pistas.push(`La diferencia coincide con: ${c.etiqueta}`);
    }
  }

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
    conciliadosBancarios,
    pistas,
    pendientesPorAplicar,
    enAppSinExtracto,
    sinContabilizar,
    sinMovimientoApp,
    totalPendientes: r2(totalPendientes),
    totalSinContabilizar: r2(totalSinContabilizar),
    totalPagosTransito: r2(totalPagosTransito),
    diferencia,
    estado: diferencia === null ? "sin_datos" : Math.abs(diferencia) <= TOL_PESOS ? "cuadra" : "diferencia",
    avisos,
  };
}
