import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell, Card, EstadoPill } from "@/components/AppShell";
import { formatCOP, formatFecha, hoyISO, type Tipo } from "@/lib/format";
import {
  actualizarMovimiento,
  marcarLegalizados,
  movimientosQuery,
  type Movimiento,
} from "@/lib/movimientos";

const inputCls =
  "rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";

export default function Movimientos() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(movimientosQuery);
  const movs = data ?? [];

  const [tcFiltro, setTcFiltro] = useState("");
  const [estadoFiltro, setEstadoFiltro] = useState("");
  const [soporteFiltro, setSoporteFiltro] = useState("");
  const [busqueda, setBusqueda] = useState("");
  const [seleccion, setSeleccion] = useState<Record<string, boolean>>({});

  const tcs = useMemo(
    () => [...new Set(movs.map((m) => m.tc))].sort((a, b) => a.localeCompare(b)),
    [movs],
  );

  const filtrados = movs.filter(
    (m) =>
      (!tcFiltro || m.tc === tcFiltro) &&
      (!estadoFiltro || m.estado === estadoFiltro) &&
      (!soporteFiltro ||
        (soporteFiltro === "con" && m.soporte_listo) ||
        (soporteFiltro === "sin" && !m.soporte_listo)) &&
      (!busqueda || m.descripcion.toLowerCase().includes(busqueda.toLowerCase())),
  );

  const invalidar = () => qc.invalidateQueries({ queryKey: movimientosQuery.queryKey });

  const cambiarTipo = useMutation({
    mutationFn: async ({ mov, tipo }: { mov: Movimiento; tipo: Tipo }) => {
      const patch: Record<string, unknown> = { tipo };
      if (tipo === "Movimiento Bancario") {
        patch["estado"] = "N/A";
        patch["fecha_legalizacion"] = null;
      } else if (mov.estado === "N/A") {
        patch["estado"] = "Pendiente";
      }
      await actualizarMovimiento(mov.id, patch);
    },
    onSuccess: invalidar,
  });

  const legalizar = useMutation({
    mutationFn: async (ids: string[]) => marcarLegalizados(ids, hoyISO()),
    onSuccess: () => {
      setSeleccion({});
      void invalidar();
    },
  });

  const cambiarSoporte = useMutation({
    mutationFn: async ({ id, valor }: { id: string; valor: boolean }) =>
      actualizarMovimiento(id, { soporte_listo: valor }),
    onSuccess: invalidar,
  });

  const idsSeleccionados = Object.keys(seleccion).filter((id) => seleccion[id]);
  const seleccionables = filtrados.filter((m) => m.tipo === "Consumo" && m.estado === "Pendiente");

  return (
    <AppShell>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[18px] font-semibold tracking-tight">Movimientos</h1>
        <button
          type="button"
          disabled={idsSeleccionados.length === 0 || legalizar.isPending}
          onClick={() => legalizar.mutate(idsSeleccionados)}
          className="rounded bg-success px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
        >
          {legalizar.isPending
            ? "Guardando…"
            : `Marcar como Legalizado (${idsSeleccionados.length})`}
        </button>
      </div>

      <Card>
        <div className="mb-4 flex flex-wrap gap-2">
          <select className={inputCls} value={tcFiltro} onChange={(e) => setTcFiltro(e.target.value)}>
            <option value="">Todas las TC</option>
            {tcs.map((tc) => (
              <option key={tc} value={tc}>
                TC {tc}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={estadoFiltro}
            onChange={(e) => setEstadoFiltro(e.target.value)}
          >
            <option value="">Todos los estados</option>
            <option value="Pendiente">Pendiente</option>
            <option value="Legalizado">Legalizado</option>
            <option value="N/A">N/A</option>
          </select>
          <select
            className={inputCls}
            value={soporteFiltro}
            onChange={(e) => setSoporteFiltro(e.target.value)}
          >
            <option value="">Soporte: todos</option>
            <option value="con">Con soporte listo</option>
            <option value="sin">Sin soporte</option>
          </select>
          <input
            className={`${inputCls} min-w-[220px] flex-1`}
            placeholder="Buscar en la descripción…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
        </div>

        {isLoading ? (
          <p className="text-muted-foreground">Cargando…</p>
        ) : filtrados.length === 0 ? (
          <p className="text-muted-foreground">No hay movimientos con esos filtros.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todos los pendientes"
                      checked={
                        seleccionables.length > 0 &&
                        seleccionables.every((m) => seleccion[m.id])
                      }
                      onChange={(e) => {
                        const next: Record<string, boolean> = {};
                        if (e.target.checked) for (const m of seleccionables) next[m.id] = true;
                        setSeleccion(next);
                      }}
                    />
                  </th>
                  <th className="px-3 py-2 font-semibold">TC</th>
                  <th className="px-3 py-2 font-semibold">Banco</th>
                  <th className="px-3 py-2 font-semibold">Fecha</th>
                  <th className="px-3 py-2 font-semibold">Descripción</th>
                  <th className="px-3 py-2 text-right font-semibold">Valor</th>
                  <th className="px-3 py-2 font-semibold">Tipo</th>
                  <th className="px-3 py-2 font-semibold">Estado</th>
                  <th className="w-16 px-3 py-2 text-center font-semibold">Soporte</th>
                  <th className="px-3 py-2 font-semibold">Archivo</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map((m) => {
                  const seleccionable = m.tipo === "Consumo" && m.estado === "Pendiente";
                  return (
                    <tr key={m.id} className="border-t border-border align-middle">
                      <td className="px-3 py-2">
                        {seleccionable ? (
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar ${m.descripcion}`}
                            checked={!!seleccion[m.id]}
                            onChange={(e) =>
                              setSeleccion((s) => ({ ...s, [m.id]: e.target.checked }))
                            }
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-2 font-semibold">{m.tc}</td>
                      <td className="px-3 py-2 text-muted-foreground">{m.banco}</td>
                      <td className="px-3 py-2 tabular-nums">{formatFecha(m.fecha)}</td>
                      <td className="max-w-[320px] px-3 py-2">{m.descripcion}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCOP(m.valor)}</td>
                      <td className="px-3 py-2">
                        <select
                          className={inputCls}
                          value={m.tipo}
                          disabled={cambiarTipo.isPending}
                          onChange={(e) =>
                            cambiarTipo.mutate({ mov: m, tipo: e.target.value as Tipo })
                          }
                        >
                          <option value="Consumo">Consumo</option>
                          <option value="Movimiento Bancario">Movimiento Bancario</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <EstadoPill estado={m.estado} />
                        {m.fecha_legalizacion ? (
                          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                            {formatFecha(m.fecha_legalizacion)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {m.tipo === "Consumo" ? (
                          <input
                            type="checkbox"
                            aria-label={`Marcar soporte listo para ${m.descripcion}`}
                            checked={m.soporte_listo}
                            disabled={cambiarSoporte.isPending}
                            title="Ya tengo la factura/soporte de este gasto, aunque no lo haya legalizado todavía"
                            onChange={(e) =>
                              cambiarSoporte.mutate({ id: m.id, valor: e.target.checked })
                            }
                          />
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {m.archivo_legalizacion_url ? (
                          
                            className="text-[12.5px] font-medium text-accent-foreground underline"
                            href={m.archivo_legalizacion_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Ver soporte
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
