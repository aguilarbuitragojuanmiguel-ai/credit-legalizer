import { supabase } from "@/integrations/supabase/client";
import type { Estado, Tipo } from "./format";

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
