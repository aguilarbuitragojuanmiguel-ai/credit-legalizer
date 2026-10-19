import { supabase } from "@/integrations/supabase/client";

import type { SeccionExtracto } from "./parsers/extracto-tc";
import type { CuentaBalance } from "./parsers/balance-excel";

/* Tablas nuevas de conciliación (cuentas_tc, saldos_libros, extractos).
 * No están en los tipos generados de Supabase: se accede con tipos propios. */

export type CuentaTC = {
  cuenta: string;
  tc: string;
  tc_alias: string | null;
  banco: string;
  moneda: "COP" | "USD";
  descripcion: string | null;
  activa: boolean;
};

export type SaldoLibro = {
  periodo: string;
  cuenta: string;
  saldo_anterior: number;
  debitos: number;
  creditos: number;
  saldo_final: number;
};

export type ExtractoGuardado = {
  id: string;
  tc: string;
  banco: string;
  moneda: "COP" | "USD";
  periodo_desde: string | null;
  fecha_corte: string;
  saldo_total: number;
  resumen: { saldoAFavor?: number } | null;
  lineas: {
    fecha: string;
    descripcion: string;
    valor: number;
    tipo: "compra" | "abono" | "cargo_bancario";
    doc: string | null;
  }[];
  archivo_nombre: string | null;
};

type Resp<T> = Promise<{ data: T | null; error: Error | null }>;
type Tabla = {
  select: (cols: string) => Resp<Record<string, unknown>[]>;
  upsert: (rows: unknown, opts?: { onConflict: string }) => Promise<{ error: Error | null }>;
  delete: () => { eq: (c: string, v: string) => Promise<{ error: Error | null }> };
};
const tabla = (n: string) => (supabase as unknown as { from: (n: string) => Tabla }).from(n);

const num = (v: unknown) => Number(v ?? 0);

export const cuentasTCQuery = {
  queryKey: ["cuentas_tc"] as const,
  queryFn: async (): Promise<CuentaTC[]> => {
    const { data, error } = await tabla("cuentas_tc").select("*");
    if (error) throw error;
    return ((data ?? []) as unknown as CuentaTC[])
      .filter((c) => c.activa !== false)
      .sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  },
};

export const saldosLibrosQuery = {
  queryKey: ["saldos_libros"] as const,
  queryFn: async (): Promise<SaldoLibro[]> => {
    const { data, error } = await tabla("saldos_libros").select("*");
    if (error) throw error;
    return (data ?? []).map((r) => ({
      periodo: String(r.periodo),
      cuenta: String(r.cuenta),
      saldo_anterior: num(r.saldo_anterior),
      debitos: num(r.debitos),
      creditos: num(r.creditos),
      saldo_final: num(r.saldo_final),
    }));
  },
};

export const extractosQuery = {
  queryKey: ["extractos"] as const,
  queryFn: async (): Promise<ExtractoGuardado[]> => {
    const { data, error } = await tabla("extractos").select("*");
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: String(r.id),
      tc: String(r.tc),
      banco: String(r.banco),
      moneda: r.moneda === "USD" ? "USD" : "COP",
      periodo_desde: (r.periodo_desde as string | null) ?? null,
      fecha_corte: String(r.fecha_corte),
      saldo_total: num(r.saldo_total),
      resumen: (r.resumen as ExtractoGuardado["resumen"]) ?? null,
      lineas: (r.lineas as ExtractoGuardado["lineas"]) ?? [],
      archivo_nombre: (r.archivo_nombre as string | null) ?? null,
    }));
  },
};

/** Guarda (o reemplaza) los saldos de las cuentas de TC de un período. */
export async function guardarSaldosLibros(periodo: string, cuentas: CuentaBalance[]) {
  const rows = cuentas.map((c) => ({
    periodo,
    cuenta: c.cuenta,
    saldo_anterior: c.saldoAnterior,
    debitos: c.debitos,
    creditos: c.creditos,
    saldo_final: c.saldoFinal,
  }));
  const { error } = await tabla("saldos_libros").upsert(rows, { onConflict: "periodo,cuenta" });
  if (error) throw error;
}

/** Guarda (o reemplaza) un extracto leído: una fila por TC + moneda + fecha de corte. */
export async function guardarExtracto(
  banco: string,
  tc: string,
  sec: SeccionExtracto,
  archivoNombre: string,
) {
  if (!sec.fechaCorte) throw new Error("El extracto no trae fecha de corte");
  const { filas, validaciones: _v, ...resumen } = sec;
  const { error } = await tabla("extractos").upsert(
    {
      tc,
      banco,
      moneda: sec.moneda,
      periodo_desde: sec.periodoDesde,
      fecha_corte: sec.fechaCorte,
      saldo_total: sec.saldoTotal,
      resumen,
      lineas: filas,
      archivo_nombre: archivoNombre,
    },
    { onConflict: "tc,moneda,fecha_corte" },
  );
  if (error) throw error;
}
