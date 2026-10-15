import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Card } from "@/components/AppShell";
import { formatCOP, formatFecha, hoyISO, trimestreAnterior, trimestreLabel } from "@/lib/format";
import { cruzarActa, type FilaCruce } from "@/lib/importar-acta";
import {
  claveTC,
  importarNoDeducibles,
  insertarNoDeduciblesImportados,
  movimientosQuery,
  type Movimiento,
  type NoDeducibleImportado,
} from "@/lib/movimientos";
import { parseActaFiscalPDF, type ResultadoActa } from "@/lib/parsers/acta-fiscal";

const inputCls =
  "rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";

/** TC que cambiaron de plástico: número en el acta -> número actual en la app */
const ALIAS_INICIAL: Record<string, string> = { "8958": "6870" };

function primerDiaDelPeriodo(periodo: string): string {
  const m = periodo.match(/^(\d{4})-T(\d)$/);
  if (!m) return hoyISO();
  const mes = (Number(m[2]) - 1) * 3 + 1;
  return `${m[1]}-${String(mes).padStart(2, "0")}-01`;
}

export function ImportarActa({ movs }: { movs: Movimiento[] }) {
  const qc = useQueryClient();
  const [leyendo, setLeyendo] = useState(false);
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const [acta, setActa] = useState<ResultadoActa | null>(null);
  const [nombreArchivo, setNombreArchivo] = useState("");
  const [periodo, setPeriodo] = useState(trimestreAnterior(hoyISO()));
  const [alias, setAlias] = useState<Record<string, string>>(ALIAS_INICIAL);
  const [override, setOverride] = useState<Record<number, boolean>>({});
  const [resultadoMsg, setResultadoMsg] = useState<string | null>(null);
  const [errorGuardar, setErrorGuardar] = useState<string | null>(null);

  const anioHoy = new Date().getFullYear();
  const periodosOpc = [anioHoy - 2, anioHoy - 1, anioHoy].flatMap((a) =>
    ["T1", "T2", "T3", "T4"].map((t) => `${a}-${t}`),
  );

  async function onArchivo(file: File | undefined) {
    if (!file) return;
    setErrorLectura(null);
    setResultadoMsg(null);
    setErrorGuardar(null);
    setLeyendo(true);
    try {
      const r = await parseActaFiscalPDF(file);
      if (r.filas.length === 0) {
        setActa(null);
        setErrorLectura("No encontré filas en ese PDF. ¿Es un acta de gastos no deducibles?");
        return;
      }
      setActa(r);
      setNombreArchivo(file.name);
      setOverride({});
      if (r.periodoSugerido) setPeriodo(r.periodoSugerido);
    } catch {
      setActa(null);
      setErrorLectura("No se pudo leer el PDF.");
    } finally {
      setLeyendo(false);
    }
  }

  const tcsActa = useMemo(() => {
    const mapa = new Map<string, number>();
    for (const f of acta?.filas ?? []) {
      const k = f.tc ?? "";
      mapa.set(k, (mapa.get(k) ?? 0) + 1);
    }
    return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [acta]);

  const cruce: FilaCruce[] = useMemo(
    () => (acta ? cruzarActa(acta.filas, alias, movs) : []),
    [acta, alias, movs],
  );

  const tcsEnApp = useMemo(() => new Set(movs.map((m) => claveTC(m.tc))), [movs]);

  function porDefecto(c: FilaCruce): boolean {
    if (c.yaDefinitivo) return false;
    if (c.match) return (c.confianza === "alta" || c.confianza === "media") && !c.aviso;
    return c.tcApp !== "";
  }
  const marcada = (c: FilaCruce) => !c.yaDefinitivo && (override[c.idx] ?? porDefecto(c));

  const aActualizar = cruce.filter((c) => c.match && !c.yaDefinitivo && marcada(c));
  const aAgregar = cruce.filter((c) => !c.match && c.tcApp !== "" && marcada(c));
  const yaDefinitivos = cruce.filter((c) => c.yaDefinitivo).length;
  const valorActualizar = aActualizar.reduce((s, c) => s + c.fila.valor, 0);
  const valorAgregar = aAgregar.reduce((s, c) => s + c.fila.valor, 0);

  const importar = useMutation({
    mutationFn: async () => {
      const hoy = hoyISO();
      const ids = aActualizar.map((c) => (c.match as Movimiento).id);
      if (ids.length > 0) await importarNoDeducibles(ids, periodo, hoy);

      const nuevos: NoDeducibleImportado[] = aAgregar.map((c) => {
        const ref = movs.find((m) => claveTC(m.tc) === c.tcApp);
        return {
          tc: ref?.tc ?? c.tcApp,
          banco: ref?.banco ?? "N/D",
          fecha: c.fila.fecha ?? primerDiaDelPeriodo(periodo),
          descripcion: c.fila.descripcion,
          valor: c.fila.valor,
        };
      });
      if (nuevos.length > 0) await insertarNoDeduciblesImportados(nuevos, periodo, hoy);
      return { actualizados: ids.length, agregados: nuevos.length };
    },
    onSuccess: (r) => {
      setErrorGuardar(null);
      setResultadoMsg(
        `Listo: ${r.actualizados} actualizado${r.actualizados === 1 ? "" : "s"} y ${r.agregados} agregado${r.agregados === 1 ? "" : "s"} como No deducible definitivo (${trimestreLabel(periodo)}). Míralos en "Control anual".`,
      );
      setActa(null);
      setOverride({});
      void qc.invalidateQueries({ queryKey: movimientosQuery.queryKey });
    },
    onError: () => {
      setResultadoMsg(null);
      setErrorGuardar(
        "No se pudo guardar. Revisa que ya corriste el SQL de la migración (columnas de no deducible) y vuelve a intentar.",
      );
    },
  });

  function pedirImportar() {
    const ok = window.confirm(
      `¿Importar esta acta como ${trimestreLabel(periodo)}?\n\n` +
        `• Actualizar ${aActualizar.length} gasto(s) existentes · ${formatCOP(valorActualizar)}\n` +
        `   (si estaban Legalizados, dejarán de contar como legalizados)\n` +
        `• Agregar ${aAgregar.length} gasto(s) nuevos · ${formatCOP(valorAgregar)}\n\n` +
        `Quedan como No deducible definitivo. Puedes devolverlos después uno a uno.`,
    );
    if (ok) importar.mutate();
  }

  function etiqueta(c: FilaCruce): { texto: string; cls: string } {
    if (c.yaDefinitivo) return { texto: "Ya estaba como No deducible", cls: "text-muted-foreground" };
    if (c.match) {
      const conf = c.confianza === "alta" ? "coincide" : c.confianza === "media" ? "probable" : "dudoso";
      return {
        texto: `Existe (${c.match.estado}) · ${conf}`,
        cls: c.confianza === "baja" ? "text-warning" : "text-success",
      };
    }
    if (c.tcApp === "") return { texto: "Sin TC: no se puede agregar", cls: "text-destructive" };
    return { texto: "No está en la app → se agrega", cls: "text-warning" };
  }

  return (
    <div className="space-y-5">
      <Card title="Importar acta anterior (PDF)">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Sube el PDF de un acta de gastos no deducibles de un trimestre anterior. Te muestro qué
          encontré y qué falta antes de guardar nada. Uno a la vez.
        </p>
        <input
          type="file"
          accept="application/pdf"
          disabled={leyendo}
          onChange={(e) => {
            void onArchivo(e.target.files?.[0]);
            e.target.value = "";
          }}
          className="text-[13px]"
        />
        {leyendo ? <p className="mt-2 text-[13px] text-muted-foreground">Leyendo PDF…</p> : null}
        {errorLectura ? <p className="mt-2 text-[13px] text-destructive">{errorLectura}</p> : null}
        {resultadoMsg ? (
          <p className="mt-2 text-[13px] font-medium text-success">{resultadoMsg}</p>
        ) : null}
      </Card>

      {acta ? (
        <>
          <Card title={`Acta leída · ${nombreArchivo}`}>
            <p className="mb-3 text-[13px]">
              <span className="font-semibold">{acta.titulo || "(sin título)"}</span> ·{" "}
              {acta.filas.length} filas · {formatCOP(acta.filas.reduce((s, f) => s + f.valor, 0))}
            </p>

            <div className="mb-4 flex flex-wrap items-center gap-2">
              <label className="text-[13px] text-muted-foreground" htmlFor="periodo-imp">
                Periodo al que pertenece
              </label>
              <select
                id="periodo-imp"
                className={inputCls}
                value={periodo}
                onChange={(e) => setPeriodo(e.target.value)}
              >
                {periodosOpc.map((p) => (
                  <option key={p} value={p}>
                    {trimestreLabel(p)}
                  </option>
                ))}
              </select>
              {acta.periodoSugerido ? (
                <span className="text-[12px] text-muted-foreground">(sugerido por el título)</span>
              ) : (
                <span className="text-[12px] text-warning">
                  El título no cubre un solo trimestre: elige el periodo a mano.
                </span>
              )}
            </div>

            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Tarjetas del acta (si una cambió de plástico, escribe el número actual)
            </p>
            <div className="mb-2 flex flex-wrap gap-3">
              {tcsActa.map(([tc, n]) => {
                const destino = claveTC(alias[tc] ?? tc);
                return (
                  <div key={tc} className="rounded border border-border bg-table-head px-3 py-2">
                    <p className="text-[12px] text-muted-foreground">
                      TC {tc || "(sin TC)"} · {n} fila{n === 1 ? "" : "s"}
                    </p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-[12px]">en la app:</span>
                      <input
                        className={`${inputCls} w-20`}
                        value={alias[tc] ?? tc}
                        onChange={(e) => setAlias((a) => ({ ...a, [tc]: e.target.value.trim() }))}
                        aria-label={`TC en la app para ${tc}`}
                      />
                    </div>
                    {destino && !tcsEnApp.has(destino) ? (
                      <p className="mt-1 text-[11.5px] text-warning">
                        No hay movimientos de la TC {destino} en la app.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card title="Vista previa">
            <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px]">
              <span>
                Actualizar: <b>{aActualizar.length}</b> · {formatCOP(valorActualizar)}
              </span>
              <span>
                Agregar: <b>{aAgregar.length}</b> · {formatCOP(valorAgregar)}
              </span>
              {yaDefinitivos > 0 ? (
                <span className="text-muted-foreground">Ya definitivos: {yaDefinitivos}</span>
              ) : null}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                    <th className="w-8 px-3 py-2" />
                    <th className="px-3 py-2 font-semibold">TC</th>
                    <th className="px-3 py-2 font-semibold">Fecha (acta)</th>
                    <th className="px-3 py-2 font-semibold">Descripción</th>
                    <th className="px-3 py-2 text-right font-semibold">Valor</th>
                    <th className="px-3 py-2 font-semibold">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {cruce.map((c) => {
                    const e = etiqueta(c);
                    const editable = !c.yaDefinitivo && (c.match !== null || c.tcApp !== "");
                    return (
                      <tr key={c.idx} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          {editable ? (
                            <input
                              type="checkbox"
                              checked={marcada(c)}
                              onChange={(ev) =>
                                setOverride((o) => ({ ...o, [c.idx]: ev.target.checked }))
                              }
                              aria-label={`Incluir ${c.fila.descripcion}`}
                            />
                          ) : null}
                        </td>
                        <td className="px-3 py-2 font-semibold">
                          {c.fila.tc ?? "—"}
                          {c.tcApp && c.tcApp !== c.fila.tc ? (
                            <span className="font-normal text-muted-foreground"> → {c.tcApp}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {c.fila.fechaTexto}
                          {c.fila.fecha === null ? (
                            <div className="text-[11.5px] text-warning">fecha ilegible</div>
                          ) : c.fila.fechaAjustada ? (
                            <div className="text-[11.5px] text-warning">
                              se usará {formatFecha(c.fila.fecha)}
                            </div>
                          ) : null}
                        </td>
                        <td className="max-w-[320px] px-3 py-2">{c.fila.descripcion}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCOP(c.fila.valor)}</td>
                        <td className={`px-3 py-2 text-[12.5px] ${e.cls}`}>
                          {e.texto}
                          {c.match ? (
                            <div className="text-[11.5px] text-muted-foreground">
                              {formatFecha(c.match.fecha)} · {c.match.descripcion}
                            </div>
                          ) : null}
                          {c.aviso ? <div className="text-[11.5px] text-warning">{c.aviso}</div> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={importar.isPending || aActualizar.length + aAgregar.length === 0}
                onClick={pedirImportar}
                className="rounded bg-destructive px-3 py-1.5 text-[13px] font-semibold text-destructive-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
              >
                {importar.isPending
                  ? "Guardando…"
                  : `Importar como ${trimestreLabel(periodo)} (${aActualizar.length} actualizar · ${aAgregar.length} agregar)`}
              </button>
              {errorGuardar ? <p className="text-[12px] text-destructive">{errorGuardar}</p> : null}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
