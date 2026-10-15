import type { FilaActa } from "./parsers/acta-fiscal";
import { claveTC, type Movimiento } from "./movimientos";

export type Confianza = "alta" | "media" | "baja";

export type FilaCruce = {
  idx: number;
  fila: FilaActa;
  /** TC como se llama hoy en la app (después de aplicar el alias) */
  tcApp: string;
  match: Movimiento | null;
  confianza: Confianza | null;
  /** Ya estaba como No deducible definitivo: no se toca */
  yaDefinitivo: boolean;
  /** Advertencia para el usuario (ej. tiene archivo de legalización) */
  aviso: string | null;
};

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
  if (x === y) return 3;
  if (x.includes(y) || y.includes(x)) return 3;
  const ta = new Set(x.split(" "));
  return y.split(" ").some((w) => w.length > 2 && ta.has(w)) ? 1 : 0;
}

function puntajeFecha(filaFecha: string | null, movFecha: string): number {
  if (!filaFecha) return 0;
  if (filaFecha === movFecha) return 3;
  return filaFecha.slice(0, 7) === movFecha.slice(0, 7) ? 1 : 0;
}

/**
 * Cruza las filas del acta con los movimientos de la app: misma TC (con alias)
 * y mismo valor (tolerancia de redondeo); desempata por fecha y descripción.
 * Cada movimiento se usa una sola vez.
 */
export function cruzarActa(
  filas: FilaActa[],
  alias: Record<string, string>,
  movs: Movimiento[],
): FilaCruce[] {
  const consumos = movs.filter((m) => m.tipo === "Consumo");

  const pares: { i: number; m: Movimiento; puntaje: number; fecha: number; desc: number }[] = [];
  filas.forEach((f, i) => {
    const tcApp = claveTC(alias[f.tc ?? ""] ?? f.tc ?? "");
    for (const m of consumos) {
      if (claveTC(m.tc) !== tcApp) continue;
      if (Math.abs(Number(m.valor) - f.valor) >= 1) continue;
      const fecha = puntajeFecha(f.fecha, m.fecha);
      const desc = puntajeDescripcion(f.descripcion, m.descripcion);
      pares.push({ i, m, puntaje: fecha + desc, fecha, desc });
    }
  });
  pares.sort((a, b) => b.puntaje - a.puntaje);

  const usadoFila = new Set<number>();
  const usadoMov = new Set<string>();
  const asignado = new Map<number, (typeof pares)[number]>();
  for (const p of pares) {
    if (usadoFila.has(p.i) || usadoMov.has(p.m.id)) continue;
    usadoFila.add(p.i);
    usadoMov.add(p.m.id);
    asignado.set(p.i, p);
  }

  return filas.map((f, idx) => {
    const tcApp = claveTC(alias[f.tc ?? ""] ?? f.tc ?? "");
    const a = asignado.get(idx);
    if (!a) {
      return { idx, fila: f, tcApp, match: null, confianza: null, yaDefinitivo: false, aviso: null };
    }
    const confianza: Confianza =
      a.fecha === 3 && a.desc >= 1 ? "alta" : a.desc === 3 || a.fecha === 3 ? "media" : "baja";
    const aviso = a.m.archivo_legalizacion_url
      ? "Tiene archivo de legalización: puede que sí se haya legalizado"
      : null;
    return {
      idx,
      fila: f,
      tcApp,
      match: a.m,
      confianza,
      yaDefinitivo: a.m.estado === "No deducible",
      aviso,
    };
  });
}
