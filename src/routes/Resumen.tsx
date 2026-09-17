import { useQuery } from "@tanstack/react-query";

import { AppShell, Card } from "@/components/AppShell";
import { formatCOP } from "@/lib/format";
import { movimientosQuery, type Movimiento } from "@/lib/movimientos";

type FilaTC = {
  tc: string;
  banco: string;
  pendientes: number;
  valorPendiente: number;
  legalizados: number;
  valorLegalizado: number;
  totalConsumos: number;
};

function agrupar(movs: Movimiento[]): FilaTC[] {
  const mapa = new Map<string, FilaTC>();
  for (const m of movs) {
    const fila =
      mapa.get(m.tc) ??
      ({
        tc: m.tc,
        banco: m.banco,
        pendientes: 0,
        valorPendiente: 0,
        legalizados: 0,
        valorLegalizado: 0,
        totalConsumos: 0,
      } satisfies FilaTC);
    if (m.tipo === "Consumo") {
      fila.totalConsumos += 1;
      if (m.estado === "Pendiente") {
        fila.pendientes += 1;
        fila.valorPendiente += Number(m.valor);
      } else if (m.estado === "Legalizado") {
        fila.legalizados += 1;
        fila.valorLegalizado += Number(m.valor);
      }
    }
    mapa.set(m.tc, fila);
  }
  return [...mapa.values()].sort((a, b) => a.tc.localeCompare(b.tc));
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-[20px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export default function Resumen() {
  const { data, isLoading, error } = useQuery(movimientosQuery);
  const movs = data ?? [];
  const filas = agrupar(movs);

  const consumos = movs.filter((m) => m.tipo === "Consumo");
  const pendientes = consumos.filter((m) => m.estado === "Pendiente");
  const pendientesConSoporte = pendientes.filter((m) => m.soporte_listo);
  const legalizados = consumos.filter((m) => m.estado === "Legalizado");
  const totalPendiente = pendientes.reduce((s, m) => s + Number(m.valor), 0);
  const totalLegalizado = legalizados.reduce((s, m) => s + Number(m.valor), 0);

  return (
    <AppShell>
      <h1 className="mb-4 text-[18px] font-semibold tracking-tight">Resumen</h1>

      {error ? (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive">
          No se pudieron cargar los movimientos.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric label="Tarjetas registradas" value={String(filas.length)} />
        <Metric label="Consumos pendientes" value={String(pendientes.length)} />
        <Metric label="Con soporte, falta legalizar" value={String(pendientesConSoporte.length)} />
        <Metric label="Valor pendiente" value={formatCOP(totalPendiente)} />
        <Metric label="Valor legalizado" value={formatCOP(totalLegalizado)} />
      </div>

      <div className="mt-5">
        <Card title="Avance por tarjeta">
          {isLoading ? (
            <p className="text-muted-foreground">Cargando…</p>
          ) : filas.length === 0 ? (
            <p className="text-muted-foreground">
              Todavía no hay movimientos. Empieza en "Subir soporte".
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">TC</th>
                    <th className="px-3 py-2 font-semibold">Banco</th>
                    <th className="px-3 py-2 text-right font-semibold"># Pend.</th>
                    <th className="px-3 py-2 text-right font-semibold">Valor pendiente</th>
                    <th className="px-3 py-2 text-right font-semibold"># Legal.</th>
                    <th className="px-3 py-2 text-right font-semibold">Valor legalizado</th>
                    <th className="px-3 py-2 font-semibold">Avance</th>
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f) => {
                    const pct =
                      f.totalConsumos > 0 ? Math.round((f.legalizados / f.totalConsumos) * 100) : 0;
                    return (
                      <tr key={f.tc} className="border-t border-border">
                        <td className="px-3 py-2 font-semibold">{f.tc}</td>
                        <td className="px-3 py-2 text-muted-foreground">{f.banco}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{f.pendientes}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-warning">
                          {formatCOP(f.valorPendiente)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{f.legalizados}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-success">
                          {formatCOP(f.valorLegalizado)}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-success"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-[12px] text-muted-foreground">
                              {pct}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
