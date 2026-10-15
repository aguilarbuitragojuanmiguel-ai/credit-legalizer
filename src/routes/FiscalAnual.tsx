import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Card } from "@/components/AppShell";
import { formatCOP, formatFecha, trimestreLabel } from "@/lib/format";
import {
  claveTC,
  devolverAPendientes,
  movimientosQuery,
  type Movimiento,
} from "@/lib/movimientos";
import { generarActaFiscalPDF } from "@/lib/pdf-fiscal";

const inputCls =
  "rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";

const TRIMESTRES = ["T1", "T2", "T3", "T4"] as const;

function anioDe(periodo: string | null): string {
  return periodo?.slice(0, 4) ?? "";
}

/** Reporte del año de lo enviado definitivamente a No deducible (estado "No deducible"). */
export function ControlAnual({
  definitivos,
  responsables,
}: {
  definitivos: Movimiento[];
  responsables: Record<string, string>;
}) {
  const qc = useQueryClient();
  const [anioSel, setAnioSel] = useState("");
  const [periodoSel, setPeriodoSel] = useState("");
  const [titulo, setTitulo] = useState("RELACION GASTOS NO DEDUCIBLES ");
  const [exportando, setExportando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const anios = useMemo(
    () =>
      [...new Set(definitivos.map((m) => anioDe(m.periodo_no_deducible)).filter(Boolean))].sort(
        (a, b) => b.localeCompare(a),
      ),
    [definitivos],
  );
  const anio = anioSel || anios[0] || String(new Date().getFullYear());

  const delAnio = definitivos.filter((m) => anioDe(m.periodo_no_deducible) === anio);
  const filtrados = delAnio.filter((m) => !periodoSel || m.periodo_no_deducible === periodoSel);
  const total = filtrados.reduce((s, m) => s + Number(m.valor), 0);

  // Matriz TC x trimestre (siempre sobre todo el año, para ver el control completo)
  const matriz = useMemo(() => {
    const mapa = new Map<string, { tc: string; porT: Record<string, { n: number; v: number }> }>();
    for (const m of delAnio) {
      const fila = mapa.get(m.tc) ?? { tc: m.tc, porT: {} };
      const t = m.periodo_no_deducible ?? "";
      const celda = fila.porT[t] ?? { n: 0, v: 0 };
      celda.n += 1;
      celda.v += Number(m.valor);
      fila.porT[t] = celda;
      mapa.set(m.tc, fila);
    }
    return [...mapa.values()].sort((a, b) => a.tc.localeCompare(b.tc));
  }, [delAnio]);

  const totalPorT = (t: string) =>
    delAnio.filter((m) => m.periodo_no_deducible === `${anio}-${t}`).reduce((s, m) => s + Number(m.valor), 0);
  const countPorT = (t: string) =>
    delAnio.filter((m) => m.periodo_no_deducible === `${anio}-${t}`).length;
  const totalAnio = delAnio.reduce((s, m) => s + Number(m.valor), 0);

  const porTC = useMemo(() => {
    const mapa = new Map<string, Movimiento[]>();
    for (const m of filtrados) {
      const arr = mapa.get(m.tc) ?? [];
      arr.push(m);
      mapa.set(m.tc, arr);
    }
    return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtrados]);

  const devolver = useMutation({
    mutationFn: (id: string) => devolverAPendientes([id]),
    onSuccess: () => qc.invalidateQueries({ queryKey: movimientosQuery.queryKey }),
  });

  async function exportarPDF() {
    setError(null);
    setExportando(true);
    try {
      const { doc, nombre } = await generarActaFiscalPDF(
        titulo,
        filtrados.map((m) => ({
          tc: m.tc,
          fecha: m.fecha,
          descripcion: m.descripcion,
          valor: Number(m.valor),
        })),
        responsables,
      );
      doc.save(`${nombre}.pdf`);
    } catch {
      setError("No se pudo generar el PDF. Intenta de nuevo.");
    } finally {
      setExportando(false);
    }
  }

  async function exportarExcel() {
    setError(null);
    try {
      const XLSX = await import("xlsx");
      const resumen: (string | number)[][] = [
        ["TC", "Responsable", ...TRIMESTRES.map((t) => `${t} ${anio}`), "Total año"],
        ...matriz.map((f) => [
          f.tc,
          responsables[claveTC(f.tc)] ?? "",
          ...TRIMESTRES.map((t) => Math.round(f.porT[`${anio}-${t}`]?.v ?? 0)),
          Math.round(Object.values(f.porT).reduce((s, c) => s + c.v, 0)),
        ]),
        ["TOTAL", "", ...TRIMESTRES.map((t) => Math.round(totalPorT(t))), Math.round(totalAnio)],
      ];
      const detalle: (string | number)[][] = [
        ["Periodo", "Enviado el", "TC", "Responsable", "Fecha gasto", "Descripción", "Valor"],
        ...[...delAnio]
          .sort(
            (a, b) =>
              (a.periodo_no_deducible ?? "").localeCompare(b.periodo_no_deducible ?? "") ||
              a.tc.localeCompare(b.tc) ||
              a.fecha.localeCompare(b.fecha),
          )
          .map((m) => [
            m.periodo_no_deducible ? trimestreLabel(m.periodo_no_deducible) : "",
            formatFecha(m.fecha_no_deducible),
            m.tc,
            responsables[claveTC(m.tc)] ?? "",
            formatFecha(m.fecha),
            m.descripcion,
            Math.round(Number(m.valor)),
          ]),
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumen), "Resumen");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detalle), "Detalle");
      XLSX.writeFile(wb, `no_deducibles_${anio}.xlsx`);
    } catch {
      setError("No se pudo generar el Excel. Intenta de nuevo.");
    }
  }

  if (definitivos.length === 0) {
    return (
      <Card>
        <p className="text-muted-foreground">
          Todavía no has llevado gastos a No deducible definitivo. En la pestaña "Por definir", filtra
          lo que corresponda y usa el botón "Llevar a no deducible definitivo"; aquí queda el control
          del año.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="rounded-md border border-border bg-card px-4 py-3 lg:col-span-1">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
            Total {anio}
          </p>
          <p className="mt-1 text-[20px] font-semibold tabular-nums text-destructive">
            {formatCOP(totalAnio)}
          </p>
          <p className="text-[12px] text-muted-foreground">{delAnio.length} gastos</p>
        </div>
        {TRIMESTRES.map((t) => (
          <div key={t} className="rounded-md border border-border bg-card px-4 py-3">
            <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
              {t} {anio}
            </p>
            <p className="mt-1 text-[20px] font-semibold tabular-nums">{formatCOP(totalPorT(t))}</p>
            <p className="text-[12px] text-muted-foreground">{countPorT(t)} gastos</p>
          </div>
        ))}
      </div>

      <Card title={`Control por tarjeta y trimestre · ${anio}`}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-semibold">TC</th>
                <th className="px-3 py-2 font-semibold">Responsable</th>
                {TRIMESTRES.map((t) => (
                  <th key={t} className="px-3 py-2 text-right font-semibold">
                    {t}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-semibold">Total año</th>
              </tr>
            </thead>
            <tbody>
              {matriz.map((f) => (
                <tr key={f.tc} className="border-t border-border">
                  <td className="px-3 py-2 font-semibold">{f.tc}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {responsables[claveTC(f.tc)] ?? "—"}
                  </td>
                  {TRIMESTRES.map((t) => {
                    const c = f.porT[`${anio}-${t}`];
                    return (
                      <td key={t} className="px-3 py-2 text-right tabular-nums">
                        {c ? formatCOP(c.v) : <span className="text-muted-foreground">—</span>}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatCOP(Object.values(f.porT).reduce((s, c) => s + c.v, 0))}
                  </td>
                </tr>
              ))}
              <tr className="border-t-2 border-border bg-table-head font-semibold">
                <td className="px-3 py-2" colSpan={2}>
                  TOTAL
                </td>
                {TRIMESTRES.map((t) => (
                  <td key={t} className="px-3 py-2 text-right tabular-nums">
                    {formatCOP(totalPorT(t))}
                  </td>
                ))}
                <td className="px-3 py-2 text-right tabular-nums">{formatCOP(totalAnio)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Detalle y exportar">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select className={inputCls} value={anio} onChange={(e) => setAnioSel(e.target.value)}>
            {(anios.length ? anios : [anio]).map((a) => (
              <option key={a} value={a}>
                Año {a}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={periodoSel}
            onChange={(e) => setPeriodoSel(e.target.value)}
          >
            <option value="">Todo el año</option>
            {TRIMESTRES.map((t) => (
              <option key={t} value={`${anio}-${t}`}>
                {t} {anio}
              </option>
            ))}
          </select>
          <span className="text-[13px] text-muted-foreground">
            {filtrados.length} gasto{filtrados.length === 1 ? "" : "s"} ·{" "}
            <span className="font-semibold text-foreground">{formatCOP(total)}</span>
          </span>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-border bg-table-head p-3">
          <input
            className={`${inputCls} min-w-[280px] flex-1`}
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Título del acta, ej: RELACION GASTOS NO DEDUCIBLES ABRIL - JUNIO 2026"
          />
          <button
            type="button"
            disabled={exportando || filtrados.length === 0}
            onClick={() => void exportarPDF()}
            className="rounded bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            {exportando ? "Generando…" : "Exportar PDF"}
          </button>
          <button
            type="button"
            disabled={delAnio.length === 0}
            onClick={() => void exportarExcel()}
            className="rounded border border-input bg-card px-3 py-1.5 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
          >
            Descargar Excel del año
          </button>
        </div>
        {error ? <p className="mb-3 text-[12px] text-destructive">{error}</p> : null}

        {porTC.length === 0 ? (
          <p className="text-muted-foreground">No hay gastos en este periodo.</p>
        ) : (
          <div className="space-y-4">
            {porTC.map(([tc, gastos]) => (
              <div key={tc} className="rounded-md border border-border">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-table-head px-4 py-2.5">
                  <p className="text-[13px] font-semibold">
                    TC {tc}
                    {responsables[claveTC(tc)] ? ` · ${responsables[claveTC(tc)]}` : ""}
                  </p>
                  <span className="text-[12.5px] font-semibold text-destructive">
                    {gastos.length} · {formatCOP(gastos.reduce((s, m) => s + Number(m.valor), 0))}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2 font-semibold">Fecha</th>
                        <th className="px-4 py-2 font-semibold">Descripción</th>
                        <th className="px-4 py-2 text-right font-semibold">Valor</th>
                        <th className="px-4 py-2 font-semibold">Periodo</th>
                        <th className="px-4 py-2 font-semibold">Enviado el</th>
                        <th className="px-4 py-2 font-semibold" />
                      </tr>
                    </thead>
                    <tbody>
                      {[...gastos]
                        .sort((a, b) => a.fecha.localeCompare(b.fecha))
                        .map((m) => (
                          <tr key={m.id} className="border-t border-border">
                            <td className="px-4 py-2 tabular-nums">{formatFecha(m.fecha)}</td>
                            <td className="max-w-[360px] px-4 py-2">{m.descripcion}</td>
                            <td className="px-4 py-2 text-right tabular-nums">{formatCOP(m.valor)}</td>
                            <td className="px-4 py-2">
                              {m.periodo_no_deducible ? trimestreLabel(m.periodo_no_deducible) : "—"}
                            </td>
                            <td className="px-4 py-2 tabular-nums text-muted-foreground">
                              {formatFecha(m.fecha_no_deducible)}
                            </td>
                            <td className="px-4 py-2 text-right">
                              <button
                                type="button"
                                disabled={devolver.isPending}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `¿Devolver a Pendientes?\n\n${m.descripcion} · ${formatCOP(m.valor)}\n\nDejará de contar como enviado a no deducible.`,
                                    )
                                  )
                                    devolver.mutate(m.id);
                                }}
                                className="text-[12px] font-medium text-muted-foreground underline hover:text-foreground"
                              >
                                Devolver
                              </button>
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
  );
}
