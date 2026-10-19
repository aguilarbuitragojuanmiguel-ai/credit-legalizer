import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";

import { AppShell, Card } from "@/components/AppShell";
import { conciliarCuenta, type ItemConciliacion, type ResultadoCuenta } from "@/lib/conciliacion";
import {
  cuentasTCQuery,
  extractosQuery,
  guardarExtracto,
  guardarSaldosLibros,
  saldosLibrosQuery,
} from "@/lib/conciliacion-db";
import { formatCOP, formatFecha, hoyISO } from "@/lib/format";
import { movimientosQuery } from "@/lib/movimientos";
import { parseBalanceExcel, type ResultadoBalance } from "@/lib/parsers/balance-excel";
import { parseExtractoPDF, type ResultadoExtracto } from "@/lib/parsers/extracto-tc";
import { fetchTRM } from "@/lib/trm";

const inputCls =
  "rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";
const btnCls =
  "rounded bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground disabled:opacity-50";

function mesAnterior(): string {
  const d = new Date(`${hoyISO()}T00:00:00`);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const usd = (n: number) =>
  `USD ${n.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type ExtractoLeido = { archivo: string; r: ResultadoExtracto };

export default function Conciliacion() {
  return (
    <AppShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-lg font-semibold">Conciliación de tarjetas</h1>
          <p className="text-[13px] text-muted-foreground">
            Libros (balance) contra extracto, cruzando línea por línea con tus movimientos.
          </p>
        </div>
        <Contenido />
      </div>
    </AppShell>
  );
}

function Contenido() {
  const qc = useQueryClient();
  const [periodo, setPeriodo] = useState(mesAnterior());
  const [abierta, setAbierta] = useState<string | null>(null);

  const cuentasQ = useQuery(cuentasTCQuery);
  const librosQ = useQuery(saldosLibrosQuery);
  const extractosQ = useQuery(extractosQuery);
  const movsQ = useQuery(movimientosQuery);

  const cuentas = cuentasQ.data ?? [];
  const extractos = extractosQ.data ?? [];

  // TRM del corte de los extractos USD del período (para pasar el saldo a pesos)
  const fechasUSD = useMemo(
    () =>
      [
        ...new Set(
          extractos
            .filter((e) => e.moneda === "USD" && e.fecha_corte.startsWith(periodo))
            .map((e) => e.fecha_corte),
        ),
      ].sort(),
    [extractos, periodo],
  );
  const trmQ = useQuery({
    queryKey: ["trm-corte", fechasUSD.join(",")],
    enabled: fechasUSD.length > 0,
    queryFn: async () => {
      const out: Record<string, number | null> = {};
      for (const f of fechasUSD) out[f] = await fetchTRM(f);
      return out;
    },
  });

  const resultados: ResultadoCuenta[] = useMemo(
    () =>
      cuentas.map((c) =>
        conciliarCuenta({
          cuenta: c,
          periodo,
          libros: librosQ.data ?? [],
          extractos,
          movs: movsQ.data ?? [],
          trm: trmQ.data ?? {},
        }),
      ),
    [cuentas, periodo, librosQ.data, extractos, movsQ.data, trmQ.data],
  );

  const refrescar = () => {
    void qc.invalidateQueries({ queryKey: saldosLibrosQuery.queryKey });
    void qc.invalidateQueries({ queryKey: extractosQuery.queryKey });
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <label className="text-[13px] font-semibold">Mes a conciliar</label>
        <input
          type="month"
          className={inputCls}
          value={periodo}
          onChange={(e) => e.target.value && setPeriodo(e.target.value)}
        />
      </div>

      {cuentasQ.error ? (
        <p className="text-destructive">
          No pude leer las tablas de conciliación. ¿Ya corriste el SQL en Supabase?
        </p>
      ) : null}

      <CargarBalance periodo={periodo} onGuardado={refrescar} onPeriodo={setPeriodo} />
      <CargarExtractos onGuardado={refrescar} />

      <Card title={`Conciliación ${periodo}`}>
        <TablaResumen
          resultados={resultados}
          abierta={abierta}
          setAbierta={setAbierta}
          cargando={cuentasQ.isLoading || movsQ.isLoading}
        />
      </Card>
    </>
  );
}

/* ---------- 1. Balance ---------- */

function CargarBalance({
  periodo,
  onGuardado,
  onPeriodo,
}: {
  periodo: string;
  onGuardado: () => void;
  onPeriodo: (p: string) => void;
}) {
  const [bal, setBal] = useState<ResultadoBalance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const guardar = useMutation({
    mutationFn: async () => {
      if (!bal?.periodo) throw new Error("El balance no trae fecha de corte");
      await guardarSaldosLibros(bal.periodo, bal.cuentas);
    },
    onSuccess: () => {
      setOk(`Saldos de ${bal?.periodo} guardados (${bal?.cuentas.length} cuentas).`);
      onGuardado();
    },
    onError: (e: Error) => setError(e.message),
  });

  async function onArchivo(file: File | undefined) {
    if (!file) return;
    setError(null);
    setOk(null);
    try {
      const r = await parseBalanceExcel(file);
      if (r.cuentas.length === 0) {
        setBal(null);
        setError("No encontré cuentas 21053xxx en ese Excel. ¿Es el Libro Mayor y Balance?");
        return;
      }
      setBal(r);
      if (r.periodo && r.periodo !== periodo) onPeriodo(r.periodo);
    } catch {
      setBal(null);
      setError("No se pudo leer el Excel.");
    }
  }

  return (
    <Card title="1. Balance (libros)">
      <p className="mb-2 text-[13px] text-muted-foreground">
        Sube el Libro Mayor y Balance del cierre. Tomo solo las cuentas de tarjeta (21053xxx).
      </p>
      <input type="file" accept=".xlsx,.xls" onChange={(e) => void onArchivo(e.target.files?.[0])} />
      {error ? <p className="mt-2 text-destructive">{error}</p> : null}
      {bal ? (
        <div className="mt-3 space-y-2">
          <p className="text-[13px]">
            {bal.empresa ?? "Empresa"} · corte {bal.fechaCorte ? formatFecha(bal.fechaCorte) : "?"} ·{" "}
            <strong>{bal.cuentas.length}</strong> cuentas de TC
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="px-2 py-1">Cuenta</th>
                  <th className="px-2 py-1">Descripción</th>
                  <th className="px-2 py-1 text-right">Saldo final</th>
                </tr>
              </thead>
              <tbody>
                {bal.cuentas.map((c) => (
                  <tr key={c.cuenta} className="border-t border-border">
                    <td className="px-2 py-1 tabular-nums">{c.cuenta}</td>
                    <td className="px-2 py-1">{c.descripcion}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{formatCOP(c.saldoFinal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={btnCls}
            disabled={guardar.isPending}
            onClick={() => {
              setError(null);
              guardar.mutate();
            }}
          >
            {guardar.isPending ? "Guardando…" : `Guardar saldos de ${bal.periodo}`}
          </button>
        </div>
      ) : null}
      {ok ? <p className="mt-2 text-success">{ok}</p> : null}
    </Card>
  );
}

/* ---------- 2. Extractos ---------- */

function CargarExtractos({ onGuardado }: { onGuardado: () => void }) {
  const [leidos, setLeidos] = useState<ExtractoLeido[]>([]);
  const [leyendo, setLeyendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const guardar = useMutation({
    mutationFn: async () => {
      let n = 0;
      for (const l of leidos) {
        if (!l.r.banco || !l.r.tc) continue;
        for (const s of l.r.secciones) {
          if (!s.fechaCorte) continue;
          await guardarExtracto(l.r.banco, l.r.tc, s, l.archivo);
          n += 1;
        }
      }
      return n;
    },
    onSuccess: (n) => {
      setOk(`${n} extracto(s) guardados.`);
      setLeidos([]);
      onGuardado();
    },
    onError: (e: Error) => setError(e.message),
  });

  async function onArchivos(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setOk(null);
    setLeyendo(true);
    const out: ExtractoLeido[] = [];
    for (const f of Array.from(files)) {
      try {
        out.push({ archivo: f.name, r: await parseExtractoPDF(f) });
      } catch {
        out.push({ archivo: f.name, r: { banco: null, tc: null, secciones: [] } });
      }
    }
    setLeidos(out);
    setLeyendo(false);
  }

  const guardables = leidos.filter((l) => l.r.banco && l.r.tc && l.r.secciones.length > 0);

  return (
    <Card title="2. Extractos de las tarjetas">
      <p className="mb-2 text-[13px] text-muted-foreground">
        Sube los PDF de los extractos (puedes elegir varios). Leo el corte, los totales y cada línea, y
        valido que los números del resumen cuadren con las líneas.
      </p>
      <input
        type="file"
        accept="application/pdf"
        multiple
        onChange={(e) => void onArchivos(e.target.files)}
      />
      {leyendo ? <p className="mt-2 text-muted-foreground">Leyendo…</p> : null}
      {error ? <p className="mt-2 text-destructive">{error}</p> : null}

      <div className="mt-3 space-y-3">
        {leidos.map((l) => (
          <div key={l.archivo} className="rounded border border-border p-3 text-[13px]">
            <p className="font-semibold">
              {l.archivo}
              {l.r.banco ? ` · ${l.r.banco} · TC ${l.r.tc ?? "?"}` : ""}
            </p>
            {l.r.secciones.length === 0 ? (
              <p className="text-destructive">No reconocí este PDF como extracto de tarjeta.</p>
            ) : (
              l.r.secciones.map((s) => (
                <div key={s.moneda} className="mt-2">
                  <p>
                    <strong>{s.moneda === "USD" ? "Dólares" : "Pesos"}</strong> · período{" "}
                    {s.periodoDesde ? formatFecha(s.periodoDesde) : "?"} →{" "}
                    <strong>corte {s.fechaCorte ? formatFecha(s.fechaCorte) : "?"}</strong> · saldo total{" "}
                    {s.moneda === "USD" ? usd(s.saldoTotal) : formatCOP(s.saldoTotal)} · {s.filas.length}{" "}
                    líneas
                  </p>
                  <ul className="mt-1">
                    {s.validaciones.map((v) => (
                      <li key={v.nombre} className={v.ok ? "text-success" : "text-destructive"}>
                        {v.ok ? "✓" : "✗"} {v.nombre}
                        {v.ok ? "" : ` (extracto ${v.esperado.toLocaleString("es-CO")} vs leído ${v.leido.toLocaleString("es-CO")})`}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        ))}
      </div>

      {guardables.length > 0 ? (
        <button
          type="button"
          className={`${btnCls} mt-3`}
          disabled={guardar.isPending}
          onClick={() => {
            setError(null);
            guardar.mutate();
          }}
        >
          {guardar.isPending ? "Guardando…" : `Guardar ${guardables.length} extracto(s)`}
        </button>
      ) : null}
      {ok ? <p className="mt-2 text-success">{ok}</p> : null}
    </Card>
  );
}

/* ---------- 3. Resumen + detalle ---------- */

function TablaResumen({
  resultados,
  abierta,
  setAbierta,
  cargando,
}: {
  resultados: ResultadoCuenta[];
  abierta: string | null;
  setAbierta: (c: string | null) => void;
  cargando: boolean;
}) {
  if (cargando) return <p className="text-muted-foreground">Cargando…</p>;
  if (resultados.length === 0) return <p className="text-muted-foreground">No hay cuentas configuradas.</p>;

  const cuadran = resultados.filter((r) => r.estado === "cuadra").length;
  const conDif = resultados.filter((r) => r.estado === "diferencia").length;
  const sinDatos = resultados.filter((r) => r.estado === "sin_datos").length;

  return (
    <>
      <p className="mb-3 text-[13px] text-muted-foreground">
        <span className="font-semibold text-success">{cuadran} cuadran</span> ·{" "}
        <span className="font-semibold text-destructive">{conDif} con diferencia</span> · {sinDatos} sin
        datos completos
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-2 py-2">Cuenta</th>
              <th className="px-2 py-2">TC</th>
              <th className="px-2 py-2">Banco</th>
              <th className="px-2 py-2 text-right">Libros</th>
              <th className="px-2 py-2 text-right">Extracto</th>
              <th className="px-2 py-2 text-right">+ Pend. por aplicar</th>
              <th className="px-2 py-2 text-right">− Sin contabilizar</th>
              <th className="px-2 py-2 text-right">Diferencia</th>
              <th className="px-2 py-2">Estado</th>
            </tr>
          </thead>
          <tbody>
            {resultados.map((r) => (
              <Fragment key={r.cuenta.cuenta}>
                <tr
                  className="cursor-pointer border-b border-border hover:bg-muted/50"
                  onClick={() => setAbierta(abierta === r.cuenta.cuenta ? null : r.cuenta.cuenta)}
                >
                  <td className="px-2 py-2 tabular-nums">{r.cuenta.cuenta}</td>
                  <td className="px-2 py-2">
                    {r.cuenta.tc}
                    {r.cuenta.moneda === "USD" ? " USD" : ""}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{r.cuenta.banco}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {r.libros === null ? "—" : formatCOP(r.libros)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {r.saldoExtractoPesos === null ? "—" : formatCOP(r.saldoExtractoPesos)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCOP(r.totalPendientes)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{formatCOP(r.totalSinContabilizar)}</td>
                  <td className="px-2 py-2 text-right font-semibold tabular-nums">
                    {r.diferencia === null ? "—" : formatCOP(r.diferencia)}
                  </td>
                  <td className="px-2 py-2">
                    <EstadoConc estado={r.estado} />
                  </td>
                </tr>
                {abierta === r.cuenta.cuenta ? (
                  <tr className="border-b border-border bg-muted/30">
                    <td colSpan={9} className="px-3 py-3">
                      <Detalle r={r} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EstadoConc({ estado }: { estado: ResultadoCuenta["estado"] }) {
  const cls =
    estado === "cuadra"
      ? "bg-success/12 text-success"
      : estado === "diferencia"
        ? "bg-destructive/12 text-destructive"
        : "bg-muted text-muted-foreground";
  const txt = estado === "cuadra" ? "Cuadra" : estado === "diferencia" ? "Diferencia" : "Faltan datos";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${cls}`}>
      {txt}
    </span>
  );
}

function ListaItems({ titulo, items, esUSD }: { titulo: string; items: ItemConciliacion[]; esUSD: boolean }) {
  return (
    <div>
      <p className="mb-1 font-semibold">
        {titulo} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-muted-foreground">Ninguno.</p>
      ) : (
        <table className="w-full text-[12.5px]">
          <tbody>
            {items.map((i, k) => (
              <tr key={`${i.movId ?? "x"}-${k}`} className="border-t border-border">
                <td className="px-2 py-1 tabular-nums">{formatFecha(i.fecha)}</td>
                <td className="px-2 py-1">
                  {i.descripcion}
                  {i.nota ? <span className="text-muted-foreground"> · {i.nota}</span> : null}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {esUSD ? `${usd(i.valorMoneda)} → ` : ""}
                  {formatCOP(i.valor)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Detalle({ r }: { r: ResultadoCuenta }) {
  const esUSD = r.cuenta.moneda === "USD";
  return (
    <div className="space-y-4 text-[13px]">
      <p className="font-semibold">
        {r.cuenta.descripcion ?? r.cuenta.cuenta}
        {r.extracto ? ` · corte ${formatFecha(r.extracto.fecha_corte)}` : ""}
      </p>

      <div className="grid max-w-[560px] grid-cols-[1fr_auto] gap-x-6 gap-y-1">
        <span>Saldo según libros</span>
        <span className="text-right tabular-nums">{r.libros === null ? "—" : formatCOP(r.libros)}</span>
        <span>
          Saldo según extracto
          {esUSD && r.saldoExtractoMoneda !== null ? ` (${usd(r.saldoExtractoMoneda)})` : ""}
        </span>
        <span className="text-right tabular-nums">
          {r.saldoExtractoPesos === null ? "—" : formatCOP(r.saldoExtractoPesos)}
        </span>
        <span>+ Egresos pendientes por aplicar</span>
        <span className="text-right tabular-nums">{formatCOP(r.totalPendientes)}</span>
        <span>− Gastos del extracto sin contabilizar</span>
        <span className="text-right tabular-nums">{formatCOP(r.totalSinContabilizar)}</span>
        <span className="font-semibold">Diferencia sin explicar</span>
        <span className="text-right font-semibold tabular-nums">
          {r.diferencia === null ? "—" : formatCOP(r.diferencia)}
        </span>
      </div>

      {r.avisos.map((a) => (
        <p key={a} className="text-warning">
          ⚠ {a}
        </p>
      ))}

      <p className="text-muted-foreground">
        {r.conciliados} línea(s) del extracto ya están contabilizadas y cruzan con la app.
      </p>
      <ListaItems titulo="Egresos pendientes por aplicar (en libros, no en el extracto)" items={r.pendientesPorAplicar} esUSD={esUSD} />
      <ListaItems titulo="Gastos del extracto sin contabilizar (siguen Pendientes)" items={r.sinContabilizar} esUSD={esUSD} />
      <ListaItems titulo="En el extracto pero sin movimiento en la app" items={r.sinMovimientoApp} esUSD={esUSD} />
    </div>
  );
}
