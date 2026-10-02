import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell, Card } from "@/components/AppShell";
import {
  formatCOP,
  formatFecha,
  mesDe,
  mesLabel,
  trimestreDe,
  trimestreLabel,
  type ClasificacionFiscal,
} from "@/lib/format";
import { movimientosQuery, type Movimiento } from "@/lib/movimientos";

const inputCls =
  "rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";

type FilaTC = {
  tc: string;
  banco: string;
  noDeducibleCount: number;
  noDeducibleValor: number;
  probableCount: number;
  probableValor: number;
  gastos: Movimiento[];
};

function agrupar(movs: Movimiento[]): FilaTC[] {
  const mapa = new Map<string, FilaTC>();
  for (const m of movs) {
    const fila =
      mapa.get(m.tc) ??
      ({
        tc: m.tc,
        banco: m.banco,
        noDeducibleCount: 0,
        noDeducibleValor: 0,
        probableCount: 0,
        probableValor: 0,
        gastos: [],
      } satisfies FilaTC);
    if (m.clasificacion_fiscal === "no_deducible") {
      fila.noDeducibleCount += 1;
      fila.noDeducibleValor += Number(m.valor);
    } else if (m.clasificacion_fiscal === "probable") {
      fila.probableCount += 1;
      fila.probableValor += Number(m.valor);
    }
    fila.gastos.push(m);
    mapa.set(m.tc, fila);
  }
  return [...mapa.values()].sort((a, b) => a.tc.localeCompare(b.tc));
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "destructive" | "warning" }) {
  const toneCls =
    tone === "destructive" ? "text-destructive" : tone === "warning" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-[20px] font-semibold tabular-nums ${toneCls}`}>{value}</p>
    </div>
  );
}

function ClasifBadge({ clasificacion }: { clasificacion: ClasificacionFiscal }) {
  if (clasificacion === "no_deducible") {
    return (
      <span className="inline-block rounded-full bg-destructive/12 px-2 py-0.5 text-[11.5px] font-semibold text-destructive">
        No deducible
      </span>
    );
  }
  if (clasificacion === "probable") {
    return (
      <span className="inline-block rounded-full bg-warning/15 px-2 py-0.5 text-[11.5px] font-semibold text-warning">
        Probable
      </span>
    );
  }
  return null;
}

export default function Fiscal() {
  const { data, isLoading } = useQuery(movimientosQuery);
  const movs = data ?? [];

  const [clasifFiltro, setClasifFiltro] = useState<"" | "no_deducible" | "probable">("");
  const [trimestreFiltro, setTrimestreFiltro] = useState("");
  const [mesFiltro, setMesFiltro] = useState("");

  const clasificados = movs.filter(
    (m) => m.tipo === "Consumo" && (m.clasificacion_fiscal === "no_deducible" || m.clasificacion_fiscal === "probable"),
  );

  const trimestresDisponibles = useMemo(
    () =>
      [...new Set(clasificados.map((m) => trimestreDe(m.fecha)).filter((t): t is string => !!t))].sort(
        (a, b) => b.localeCompare(a),
      ),
    [clasificados],
  );

  const mesesDisponibles = useMemo(
    () =>
      [...new Set(clasificados.map((m) => mesDe(m.fecha)).filter((t): t is string => !!t))].sort((a, b) =>
        b.localeCompare(a),
      ),
    [clasificados],
  );

  const filtrados = clasificados.filter(
    (m) =>
      (!clasifFiltro || m.clasificacion_fiscal === clasifFiltro) &&
      (!trimestreFiltro || trimestreDe(m.fecha) === trimestreFiltro) &&
      (!mesFiltro || (mesDe(m.fecha) ?? "") <= mesFiltro),
  );

  const filas = agrupar(filtrados);

  const totalNoDeducible = filtrados
    .filter((m) => m.clasificacion_fiscal === "no_deducible")
    .reduce((s, m) => s + Number(m.valor), 0);
  const totalProbable = filtrados
    .filter((m) => m.clasificacion_fiscal === "probable")
    .reduce((s, m) => s + Number(m.valor), 0);
  const countNoDeducible = filtrados.filter((m) => m.clasificacion_fiscal === "no_deducible").length;
  const countProbable = filtrados.filter((m) => m.clasificacion_fiscal === "probable").length;

  return (
    <AppShell>
      <h1 className="mb-4 text-[18px] font-semibold tracking-tight">Dashboard fiscal trimestral</h1>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Gastos no deducibles" value={String(countNoDeducible)} tone="destructive" />
        <Metric label="Valor no deducible" value={formatCOP(totalNoDeducible)} tone="destructive" />
        <Metric label="Gastos probables" value={String(countProbable)} tone="warning" />
        <Metric label="Valor probable" value={formatCOP(totalProbable)} tone="warning" />
      </div>

      <div className="mt-5">
        <Card>
          <div className="mb-4 flex flex-wrap gap-2">
            <select
              className={inputCls}
              value={clasifFiltro}
              onChange={(e) => setClasifFiltro(e.target.value as "" | "no_deducible" | "probable")}
            >
              <option value="">Clasificación: ambas</option>
              <option value="no_deducible">Solo no deducible</option>
              <option value="probable">Solo probable</option>
            </select>
            <select
              className={inputCls}
              value={trimestreFiltro}
              onChange={(e) => setTrimestreFiltro(e.target.value)}
            >
              <option value="">Todos los trimestres</option>
              {trimestresDisponibles.map((t) => (
                <option key={t} value={t}>
                  {trimestreLabel(t)}
                </option>
              ))}
            </select>
            <select className={inputCls} value={mesFiltro} onChange={(e) => setMesFiltro(e.target.value)}>
              <option value="">Hasta cualquier mes</option>
              {mesesDisponibles.map((m) => (
                <option key={m} value={m}>
                  Hasta {mesLabel(m)}
                </option>
              ))}
            </select>
            {(clasifFiltro || trimestreFiltro || mesFiltro) && (
              <button
                type="button"
                onClick={() => {
                  setClasifFiltro("");
                  setTrimestreFiltro("");
                  setMesFiltro("");
                }}
                className="rounded px-3 py-1.5 text-[13px] font-medium text-muted-foreground underline hover:text-foreground"
              >
                Limpiar filtros
              </button>
            )}
          </div>

          {isLoading ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : filas.length === 0 ? (
            <p className="text-muted-foreground">
              No hay gastos clasificados como No Deducible o Probable con estos filtros. Márcalos
              desde la pantalla de Movimientos.
            </p>
          ) : (
            <div className="space-y-4">
              {filas.map((f) => (
                <div key={f.tc} className="rounded-md border border-border">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-table-head px-4 py-2.5">
                    <p className="text-[13px] font-semibold">
                      TC {f.tc} <span className="text-muted-foreground">· {f.banco}</span>
                    </p>
                    <div className="flex flex-wrap gap-4 text-[12.5px]">
                      {f.noDeducibleCount > 0 ? (
                        <span className="text-destructive">
                          No deducible: {f.noDeducibleCount} · {formatCOP(f.noDeducibleValor)}
                        </span>
                      ) : null}
                      {f.probableCount > 0 ? (
                        <span className="text-warning">
                          Probable: {f.probableCount} · {formatCOP(f.probableValor)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                          <th className="px-4 py-2 font-semibold">Fecha</th>
                          <th className="px-4 py-2 font-semibold">Descripción</th>
                          <th className="px-4 py-2 text-right font-semibold">Valor</th>
                          <th className="px-4 py-2 font-semibold">Clasificación</th>
                        </tr>
                      </thead>
                      <tbody>
                        {f.gastos
                          .sort((a, b) => +new Date(a.fecha) - +new Date(b.fecha))
                          .map((m) => (
                            <tr key={m.id} className="border-t border-border">
                              <td className="px-4 py-2 tabular-nums">{formatFecha(m.fecha)}</td>
                              <td className="max-w-[360px] px-4 py-2">{m.descripcion}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{formatCOP(m.valor)}</td>
                              <td className="px-4 py-2">
                                <ClasifBadge clasificacion={m.clasificacion_fiscal} />
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
