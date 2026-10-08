import { supabase } from "@/integrations/supabase/client";
import type { ClasificacionFiscal, Estado, Tipo } from "./format";

export type Movimiento = {
  id: string;
  tc: string;
  banco: string;
  fecha: string;
  doc: string | null;
  descripcion: string;
  valor: number;
  tipo: Tipo;
  estado: Estado;
  fecha_legalizacion: string | null;
  proveedor_legalizacion: string | null;
  archivo_legalizacion_url: string | null;
  moneda: string;
  valor_original: number | null;
  trm: number | null;
  soporte_listo: boolean;
  clasificacion_fiscal: ClasificacionFiscal;
  created_at: string;
};

export type NuevoMovimiento = {
  tc: string;
  banco: string;
  fecha: string;
  doc?: string | null;
  descripcion: string;
  valor: number;
  tipo: Tipo;
  estado: Estado;
  moneda?: string;
  valor_original?: number | null;
  trm?: number | null;
};

export const movimientosQuery = {
  queryKey: ["movimientos"] as const,
  queryFn: async (): Promise<Movimiento[]> => {
    const { data, error } = await supabase
      .from("movimientos")
      .select("*")
      .order("fecha", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as unknown as Movimiento[];
  },
};

export async function insertarMovimientos(rows: NuevoMovimiento[]) {
  const { error } = await supabase.from("movimientos").insert(rows as never);
  if (error) throw error;
}

export async function actualizarMovimiento(id: string, patch: Record<string, unknown>) {
  const { error } = await supabase
    .from("movimientos")
    .update(patch as never)
    .eq("id", id);
  if (error) throw error;
}

export async function marcarLegalizados(ids: string[], fecha: string) {
  const { error } = await supabase
    .from("movimientos")
    .update({ estado: "Legalizado", fecha_legalizacion: fecha } as never)
    .in("id", ids);
  if (error) throw error;
}

/* ---------- Responsable por tarjeta ---------- */

type TablaResponsables = {
  from: (t: string) => {
    select: (c: string) => Promise<{
      data: { tc: string; responsable: string }[] | null;
      error: Error | null;
    }>;
    upsert: (row: { tc: string; responsable: string }) => Promise<{ error: Error | null }>;
    delete: () => { eq: (c: string, v: string) => Promise<{ error: Error | null }> };
  };
};
const tabla = () => (supabase as unknown as TablaResponsables).from("tc_responsables");

/** "TC 8674" / "tc8674" / "8674" -> "8674" */
export function claveTC(tc: string): string {
  return tc.replace(/^\s*tc\s*/i, "").trim();
}

export const responsablesQuery = {
  queryKey: ["tc_responsables"] as const,
  queryFn: async (): Promise<Record<string, string>> => {
    const { data, error } = await tabla().select("tc,responsable");
    if (error) throw error;
    const mapa: Record<string, string> = {};
    for (const r of data ?? []) mapa[claveTC(r.tc)] = r.responsable;
    return mapa;
  },
};

export async function guardarResponsable(tc: string, responsable: string) {
  const nombre = responsable.trim();
  if (!nombre) {
    const { error } = await tabla().delete().eq("tc", claveTC(tc));
    if (error) throw error;
    return;
  }
  const { error } = await tabla().upsert({ tc: claveTC(tc), responsable: nombre });
  if (error) throw error;
}
