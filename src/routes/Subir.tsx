import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { AppShell, Card } from "@/components/AppShell";
import {
  clasificar,
  estadoInicial,
  formatCOP,
  formatFecha,
  hoyISO,
  parseCOP,
  type Tipo,
} from "@/lib/format";
import {
  actualizarMovimiento,
  insertarMovimientos,
  movimientosQuery,
  type Movimiento,
  type NuevoMovimiento,
} from "@/lib/movimientos";
import { parseDaviviendaPdf } from "@/lib/parsers/davivienda";
import { parseBancolombiaExcel } from "@/lib/parsers/bancolombia";
import { parseBancolombiaPdf } from "@/lib/parsers/bancolombia-pdf";
import { parseLegalizacionExcel, type GastoLegalizado } from "@/lib/parsers/legalizacion";
import { subirArchivoLegalizacion } from "@/lib/legalizacion-upload";
import { fetchTRM } from "@/lib/trm";

const inputCls =
  "w-full rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";
const btnPrimary =
  "rounded bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40";
const btnGhost =
  "rounded border border-input bg-card px-3 py-1.5 text-[13px] font-medium transition-colors hover:bg-secondary";

type Modo = "menu" | "semana" | "legalizacion" | "manual";

type FilaPrev = {
  key: string;
  tc: string;
  banco: string;
  fecha: string;
  doc: string | null;
  descripcion: string;
  valor: number;
  tipo: Tipo;
  moneda: "COP" | "USD";
  valorOriginal: number | null;
  trm: number | null;
  duplicado: boolean;
  incluir: boolean;
};

let seq = 0;
const nextKey = () => `f${++seq}`;

/** Marca duplicados contra lo ya guardado (Doc para Davivienda, combinación exacta para el resto) */
function marcarDuplicados(filas: FilaPrev[], existentes: Movimiento[]): FilaPrev[] {
  const docs = new Set(
    existentes.filter((m) => m.doc).map((m) => `${m.tc}|${m.doc}`),
  );
  const conteo = new Map<string, number>();
  for (const m of existentes) {
    const k = `${m.tc}|${m.fecha}|${Math.round(Number(m.valor))}|${m.descripcion.trim().toUpperCase()}`;
    conteo.set(k, (conteo.get(k) ?? 0) + 1);
  }

  return filas.map((f) => {
    let duplicado = false;
    if (f.banco === "Davivienda" && f.doc) {
      duplicado = docs.has(`${f.tc}|${f.doc}`);
    } else {
      const k = `${f.tc}|${f.fecha}|${Math.round(f.valor)}|${f.descripcion.trim().toUpperCase()}`;
      const restantes = conteo.get(k) ?? 0;
      if (restantes > 0) {
        duplicado = true;
        conteo.set(k, restantes - 1);
      }
    }
    return { ...f, duplicado, incluir: !duplicado };
  });
}

export default function Subir() {
  const [modo, setModo] = useState<Modo>("menu");

  return (
    <AppShell>
      <h1 className="mb-4 text-[18px] font-semibold tracking-tight">Subir soporte</h1>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {(
          [
            ["semana", "Movimientos de la semana", "Extracto PDF (Davivienda) o Excel (Bancolombia)"],
            ["legalizacion", "Excel de legalización", "Cruza gastos legalizados contra pendientes"],
            ["manual", "Agregar movimiento manual", "Registra filas a mano, varias de una vez"],
          ] as const
        ).map(([value, titulo, sub]) => (
          <button
            key={value}
            type="button"
            onClick={() => setModo(value)}
            className={`rounded-md border px-4 py-3 text-left transition-colors ${
              modo === value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:bg-secondary"
            }`}
          >
            <span className="block text-[14px] font-semibold">{titulo}</span>
            <span className="mt-0.5 block text-[12px] opacity-70">{sub}</span>
          </button>
        ))}
      </div>

      {modo === "semana" ? <ModoSemana /> : null}
      {modo === "legalizacion" ? <ModoLegalizacion /> : null}
      {modo === "manual" ? <ModoManual /> : null}
      {modo === "menu" ? (
        <p className="text-muted-foreground">Elige una opción para empezar.</p>
      ) : null}
    </AppShell>
  );
}

/* ------------------------------- Modo A ------------------------------- */

function ModoSemana() {
  const qc = useQueryClient();
  const { data: existentes } = useQuery(movimientosQuery);
  const [banco, setBanco] = useState<"Davivienda" | "Bancolombia">("Davivienda");
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [imagenOcr, setImagenOcr] = useState<string | null>(null);
  const [filas, setFilas] = useState<FilaPrev[]>([]);
  const [leidas, setLeidas] = useState(0);
  const [tcManual, setTcManual] = useState("");
  const [archivosLeidos, setArchivosLeidos] = useState<string[]>([]);
  const [corte, setCorte] = useState("");

  const recalcular = (base: FilaPrev[]) => marcarDuplicados(base, existentes ?? []);

  /** Quita repetidos entre los propios archivos subidos */
  function dedupInterno(base: FilaPrev[]): FilaPrev[] {
    const vistos = new Set<string>();
    const out: FilaPrev[] = [];
    for (const f of base) {
      const k =
        f.doc && f.banco === "Davivienda"
          ? `d|${f.tc}|${f.doc}`
          : `x|${f.tc}|${f.fecha}|${Math.round(f.valor)}|${f.descripcion.trim().toUpperCase()}`;
      if (vistos.has(k)) continue;
      vistos.add(k);
      out.push(f);
    }
    return out;
  }

  async function onArchivos(files: File[]) {
    setCargando(true);
    setAviso(null);
    setImagenOcr(null);
    setCorte("");
    const acumulado: FilaPrev[] = [];
    const nombres: string[] = [];
    const errores: string[] = [];
    let tcDetectado = tcManual.trim();

    for (const file of files) {
      try {
        if (banco === "Davivienda") {
          const res = await parseDaviviendaPdf(file);
          const tc = tcDetectado || res.tc || "";
          if (res.tc && !tcDetectado) tcDetectado = res.tc;
          if (res.filas.length === 0) errores.push(`${file.name}: sin filas legibles`);
          for (const f of res.filas) {
            acumulado.push({
              key: nextKey(),
              tc: res.tc || tc,
              banco,
              fecha: f.fecha,
              doc: f.doc,
              descripcion: f.descripcion,
              valor: f.valor,
              tipo: clasificar(f.descripcion),
              moneda: "COP",
              valorOriginal: null,
              trm: null,
              duplicado: false,
              incluir: true,
            });
          }
        } else if (/\.pdf$/i.test(file.name)) {
          const res = await parseBancolombiaPdf(file);
          const tc = tcDetectado || res.tc || "";
          if (res.tc && !tcDetectado) tcDetectado = res.tc;
          if (res.filas.length === 0) errores.push(`${file.name}: sin filas legibles`);
          for (const f of res.filas) {
            acumulado.push({
              key: nextKey(),
              tc: res.tc || tc,
              banco,
              fecha: f.fecha,
              doc: null,
              descripcion: f.descripcion,
              valor: f.valor,
              tipo: clasificar(f.descripcion),
              moneda: f.moneda,
              valorOriginal: f.moneda === "USD" ? f.valor : null,
              trm: null,
              duplicado: false,
              incluir: true,
            });
          }
        } else {
          const res = await parseBancolombiaExcel(file);
          const tc = tcDetectado || res.tc || "";
          if (res.tc && !tcDetectado) tcDetectado = res.tc;
          if (res.imagenUrl) setImagenOcr(res.imagenUrl);
          if (res.filas.length === 0) errores.push(`${file.name}: sin filas legibles`);
          for (const f of res.filas) {
            acumulado.push({
              key: nextKey(),
              tc: res.tc || tc,
              banco,
              fecha: f.fecha,
              doc: null,
              descripcion: f.descripcion,
              valor: f.valor,
              tipo: clasificar(f.descripcion),
              moneda: "COP",
              valorOriginal: null,
              trm: null,
              duplicado: false,
              incluir: true,
            });
          }
        }
        nombres.push(file.name);
      } catch (e) {
        errores.push(`${file.name}: ${e instanceof Error ? e.message : "error desconocido"}`);
      }
    }

    // Convierte los cobros en USD a pesos con la TRM oficial del día del movimiento
    const sinTrm: string[] = [];
    for (const f of acumulado) {
      if (f.moneda !== "USD") continue;
      const trm = await fetchTRM(f.fecha);
      if (trm) {
        f.trm = trm;
        f.valor = Math.round((f.valorOriginal ?? 0) * trm);
      } else {
        sinTrm.push(`${f.descripcion.slice(0, 25)} (${formatFecha(f.fecha)})`);
      }
    }

    const ordenado = dedupInterno(acumulado).sort((a, b) => a.fecha.localeCompare(b.fecha));
    if (tcDetectado) setTcManual(tcDetectado);
    setArchivosLeidos(nombres);
    setLeidas(ordenado.length);
    setFilas(recalcular(ordenado.map((f) => ({ ...f, tc: f.tc || tcDetectado }))));
    setAviso(
      [
        nombres.length > 1 ? `${nombres.length} archivos procesados.` : null,
        banco === "Bancolombia"
          ? "Las descripciones vienen de OCR: revísalas antes de confirmar."
          : null,
        acumulado.some((f) => f.moneda === "USD")
          ? "Los cobros en USD se convirtieron a pesos con la TRM oficial del día de cada movimiento."
          : null,
        sinTrm.length
          ? `Sin TRM disponible para: ${sinTrm.join(", ")} — quedaron con el valor en dólares, ajústalos a mano.`
          : null,
        errores.length ? `Problemas: ${errores.join(" · ")}` : null,
        ordenado.length
          ? "Elige desde qué movimiento quieres tomar los datos para no repetir lo ya cargado."
          : "No se leyó ninguna fila. Agrega las filas a mano abajo.",
      ]
        .filter(Boolean)
        .join(" ") || null,
    );
    setCargando(false);
  }

  function actualizar(key: string, patch: Partial<FilaPrev>) {
    setFilas((prev) =>
      prev.map((f) => {
        if (f.key !== key) return f;
        const next = { ...f, ...patch };
        if (patch.descripcion !== undefined) next.tipo = clasificar(patch.descripcion);
        return next;
      }),
    );
  }

  function aplicarTcATodas(tc: string) {
    setTcManual(tc);
    setFilas((prev) => recalcular(prev.map((f) => ({ ...f, tc }))));
  }

  async function confirmar() {
    const aInsertar = filas.filter((f) => f.incluir);
    if (aInsertar.some((f) => !f.tc.trim())) {
      setAviso("Falta el número de TC. Escríbelo arriba antes de guardar.");
      return;
    }
    setGuardando(true);
    try {
      const rows: NuevoMovimiento[] = aInsertar.map((f) => ({
        tc: f.tc.trim(),
        banco: f.banco,
        fecha: f.fecha,
        doc: f.doc,
        descripcion: f.descripcion.trim(),
        valor: f.valor,
        tipo: f.tipo,
        estado: estadoInicial(f.tipo),
        moneda: f.moneda,
        valor_original: f.valorOriginal,
        trm: f.trm,
      }));
      await insertarMovimientos(rows);
      await qc.invalidateQueries({ queryKey: movimientosQuery.queryKey });
      setFilas([]);
      setLeidas(0);
      setAviso(`Se guardaron ${rows.length} movimientos.`);
    } catch (e) {
      setAviso(`No se pudo guardar: ${e instanceof Error ? e.message : "error desconocido"}`);
    } finally {
      setGuardando(false);
    }
  }

  const tcActual = (tcManual || filas[0]?.tc || "").trim();
  const ultimoGuardado = useMemo(() => {
    const lista = (existentes ?? []).filter((m) => !tcActual || m.tc === tcActual);
    return (
      [...lista].sort(
        (a, b) => a.fecha.localeCompare(b.fecha) || a.created_at.localeCompare(b.created_at),
      ).at(-1) ?? null
    );
  }, [existentes, tcActual]);

  const nuevos = filas.filter((f) => !f.duplicado).length;
  const dups = filas.length - nuevos;

  return (
    <div className="space-y-4">
      <Card title="1. Banco y archivo">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted-foreground">Banco</span>
            <select
              className={inputCls}
              value={banco}
              onChange={(e) => setBanco(e.target.value as "Davivienda" | "Bancolombia")}
            >
              <option value="Davivienda">Davivienda (PDF)</option>
              <option value="Bancolombia">Bancolombia (Excel o PDF de movimientos)</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted-foreground">
              Archivos {banco === "Davivienda" ? "PDF" : "Excel o PDF"} (puedes elegir varios)
            </span>
            <input
              type="file"
              multiple
              accept={banco === "Davivienda" ? ".pdf" : ".xlsx,.xls,.pdf"}
              className="text-[13px]"
              onChange={(e) => {
                const fs = Array.from(e.target.files ?? []);
                if (fs.length) void onArchivos(fs);
              }}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-muted-foreground">TC</span>
            <input
              className={inputCls}
              placeholder="ej. 2722"
              value={tcManual}
              onChange={(e) => aplicarTcATodas(e.target.value)}
            />
          </label>
        </div>
        {cargando ? (
          <p className="mt-3 text-muted-foreground">
            Leyendo archivo{banco === "Bancolombia" ? " y corriendo OCR sobre la imagen" : ""}…
          </p>
        ) : null}
        {aviso ? (
          <p className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            {aviso}
          </p>
        ) : null}
        {imagenOcr ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[12.5px] text-muted-foreground">
              Ver imagen usada para el OCR
            </summary>
            <img src={imagenOcr} alt="Captura de movimientos del Excel" className="mt-2 max-w-full" />
          </details>
        ) : null}
      </Card>

      {filas.length > 0 ? (
        <Card title="2. ¿Desde qué movimiento tomar?">
          <p className="mb-3 text-[12.5px] text-muted-foreground">
            {archivosLeidos.length > 0 ? `Archivos: ${archivosLeidos.join(", ")}. ` : ""}
            {ultimoGuardado
              ? `El último movimiento ya guardado de la TC ${tcManual || ultimoGuardado.tc} es del ${formatFecha(ultimoGuardado.fecha)}: ${ultimoGuardado.descripcion} (${formatCOP(ultimoGuardado.valor)}).`
              : "No hay movimientos guardados de esta TC todavía."}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-muted-foreground">
                Tomar desde este movimiento (inclusive)
              </span>
              <select
                className={`${inputCls} min-w-[320px]`}
                value={corte}
                onChange={(e) => setCorte(e.target.value)}
              >
                <option value="">Selecciona un movimiento…</option>
                {filas.map((f, i) => (
                  <option key={f.key} value={f.key}>
                    {i + 1}. {formatFecha(f.fecha)} · {f.descripcion.slice(0, 40)} ·{" "}
                    {formatCOP(f.valor)}
                    {f.duplicado ? " (ya existe)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={btnPrimary}
              disabled={!corte}
              onClick={() => {
                const idx = filas.findIndex((f) => f.key === corte);
                if (idx < 0) return;
                setFilas((prev) => prev.map((f, i) => ({ ...f, incluir: i >= idx && !f.duplicado })));
              }}
            >
              Aplicar corte
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() =>
                setFilas((prev) => prev.map((f) => ({ ...f, incluir: !f.duplicado })))
              }
            >
              Tomar todos los nuevos
            </button>
            <button
              type="button"
              className={btnGhost}
              onClick={() => setFilas((prev) => prev.map((f) => ({ ...f, incluir: false })))}
            >
              Quitar todos
            </button>
          </div>
        </Card>
      ) : null}

      <Card title="3. Previsualización (edita antes de guardar)">
        {filas.length > 0 ? (
          <p className="mb-3 text-[12.5px] text-muted-foreground">
            {leidas} movimientos leídos → <strong className="text-foreground">{nuevos} nuevos</strong>
            , {dups} ya estaban guardados, {filas.filter((f) => f.incluir).length} marcados para
            guardar.
          </p>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                <th className="w-8 px-2 py-2">Inc.</th>
                <th className="px-2 py-2 font-semibold">TC</th>
                <th className="px-2 py-2 font-semibold">Fecha</th>
                <th className="px-2 py-2 font-semibold">Doc</th>
                <th className="px-2 py-2 font-semibold">Descripción</th>
                <th className="px-2 py-2 font-semibold">Valor</th>
                <th className="px-2 py-2 font-semibold">Tipo</th>
                <th className="px-2 py-2 font-semibold">Estado archivo</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr
                  key={f.key}
                  className={`border-t border-border ${f.duplicado ? "bg-muted/60" : ""}`}
                >
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label="Incluir fila"
                      checked={f.incluir}
                      onChange={(e) => actualizar(f.key, { incluir: e.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      className={`${inputCls} w-20`}
                      value={f.tc}
                      onChange={(e) => actualizar(f.key, { tc: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="date"
                      className={`${inputCls} w-36`}
                      value={f.fecha}
                      onChange={(e) => actualizar(f.key, { fecha: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      className={`${inputCls} w-20`}
                      value={f.doc ?? ""}
                      onChange={(e) => actualizar(f.key, { doc: e.target.value || null })}
                    />
                  </td>
                  <td className="min-w-[240px] px-2 py-1.5">
                    <input
                      className={inputCls}
                      value={f.descripcion}
                      onChange={(e) => actualizar(f.key, { descripcion: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      className={`${inputCls} w-32 text-right tabular-nums`}
                      value={String(f.valor)}
                      onChange={(e) => actualizar(f.key, { valor: parseCOP(e.target.value) })}
                    />
                    {f.moneda === "USD" && f.valorOriginal != null ? (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        USD {f.valorOriginal.toLocaleString("es-CO")}
                        {f.trm
                          ? ` × TRM ${f.trm.toLocaleString("es-CO", { maximumFractionDigits: 2 })}`
                          : " · sin TRM, valor en dólares"}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">
                    <select
                      className={`${inputCls} w-44`}
                      value={f.tipo}
                      onChange={(e) => actualizar(f.key, { tipo: e.target.value as Tipo })}
                    >
                      <option value="Consumo">Consumo</option>
                      <option value="Movimiento Bancario">Movimiento Bancario</option>
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${
                        f.duplicado ? "bg-muted text-muted-foreground" : "bg-success/12 text-success"
                      }`}
                    >
                      {f.duplicado ? "Ya existe" : "Nuevo"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      className="text-[12px] text-destructive underline"
                      onClick={() => setFilas((prev) => prev.filter((x) => x.key !== f.key))}
                    >
                      Borrar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={btnGhost}
            onClick={() =>
              setFilas((prev) => [
                ...prev,
                {
                  key: nextKey(),
                  tc: tcManual,
                  banco,
                  fecha: hoyISO(),
                  doc: null,
                  descripcion: "",
                  valor: 0,
                  tipo: "Consumo",
                  moneda: "COP",
                  valorOriginal: null,
                  trm: null,
                  duplicado: false,
                  incluir: true,
                },
              ])
            }
          >
            + Agregar fila a mano
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={guardando || filas.filter((f) => f.incluir).length === 0}
            onClick={() => void confirmar()}
          >
            {guardando
              ? "Guardando…"
              : `Confirmar y guardar (${filas.filter((f) => f.incluir).length})`}
          </button>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------- Modo B ------------------------------- */

type FilaLegal = {
  key: string;
  archivoKeys: string[];
  archivoNombre: string;
  tc: string;
  fecha: string;
  proveedor: string;
  valor: number;
  cruceId: string;
  candidatos: Movimiento[];
  grupo: number; // 1 = fila individual, >1 = N registros del Excel fusionados (gasto compartido)
};

type Sugerencia = {
  id: string;
  filaKeys: string[];
  pendienteId: string;
  pendienteDesc: string;
  pendienteFecha: string;
  pendienteValor: number;
  valorSuma: number;
  fecha: string;
  proveedor: string;
  tc: string;
};

function normTexto(v: string): string {
  return v
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function ModoLegalizacion() {
  const qc = useQueryClient();
  const { data: movs } = useQuery(movimientosQuery);
  const [archivos, setArchivos] = useState<Array<{ key: string; file: File }>>([]);
  const [filas, setFilas] = useState<FilaLegal[]>([]);
  const [sugerencias, setSugerencias] = useState<Sugerencia[]>([]);
  const [descartadas, setDescartadas] = useState<Set<string>>(new Set());
  const [aviso, setAviso] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const pendientes = useMemo(
    () => (movs ?? []).filter((m) => m.tipo === "Consumo" && m.estado === "Pendiente"),
    [movs],
  );

  function candidatosPara(tc: string, gasto: { fecha: string; valor: number }) {
    return pendientes
      .filter((m) => m.tc === tc && Math.abs(Number(m.valor) - gasto.valor) <= 1000)
      .sort(
        (a, b) =>
          Math.abs(+new Date(a.fecha) - +new Date(gasto.fecha)) -
          Math.abs(+new Date(b.fecha) - +new Date(gasto.fecha)),
      );
  }

  function construirFilas(
    gastos: Array<GastoLegalizado & { archivoKey: string; archivoNombre: string }>,
  ): FilaLegal[] {
    const usados = new Set<string>();
    return gastos.map((g) => {
      const tc = g.tc ?? "";
      const cands = tc ? candidatosPara(tc, g) : [];
      const libre = cands.find((c) => !usados.has(c.id));
      if (libre) usados.add(libre.id);
      return {
        key: nextKey(),
        archivoKeys: [g.archivoKey],
        archivoNombre: g.archivoNombre,
        tc,
        fecha: g.fecha,
        proveedor: g.proveedor,
        valor: g.valor,
        cruceId: libre?.id ?? "",
        candidatos: cands,
        grupo: 1,
      };
    });
  }

  // Entre las filas SIN cruce individual, busca grupos (misma TC + fecha + proveedor)
  // cuya SUMA coincida con un pendiente todavía libre. No las fusiona sola: las deja
  // como sugerencia para que el usuario acepte o rechace (evita cruces ambiguos, p.ej.
  // dos compras iguales del mismo día que en realidad son gastos distintos).
  function recalcularSugerencias(
    filasActuales: FilaLegal[],
    descartadasActuales: Set<string>,
  ): Sugerencia[] {
    const sinMatch = filasActuales.filter((f) => !f.cruceId);
    const idsUsados = new Set(filasActuales.filter((f) => f.cruceId).map((f) => f.cruceId));

    const grupos = new Map<string, FilaLegal[]>();
    for (const f of sinMatch) {
      const k = `${f.tc}|${f.fecha}|${normTexto(f.proveedor)}`;
      const arr = grupos.get(k) ?? [];
      arr.push(f);
      grupos.set(k, arr);
    }

    const resultado: Sugerencia[] = [];
    for (const grupo of grupos.values()) {
      if (grupo.length < 2) continue;
      const tc = grupo[0]!.tc;
      const suma = grupo.reduce((s, f) => s + f.valor, 0);
      const candidato = pendientes
        .filter((m) => m.tc === tc && !idsUsados.has(m.id) && Math.abs(Number(m.valor) - suma) <= 1000)
        .sort(
          (a, b) =>
            Math.abs(+new Date(a.fecha) - +new Date(grupo[0]!.fecha)) -
            Math.abs(+new Date(b.fecha) - +new Date(grupo[0]!.fecha)),
        )[0];
      if (!candidato) continue;
      const filaKeys = grupo.map((f) => f.key).sort();
      const id = `${filaKeys.join(",")}|${candidato.id}`;
      if (descartadasActuales.has(id)) continue;
      resultado.push({
        id,
        filaKeys,
        pendienteId: candidato.id,
        pendienteDesc: candidato.descripcion,
        pendienteFecha: candidato.fecha,
        pendienteValor: Number(candidato.valor),
        valorSuma: suma,
        fecha: grupo[0]!.fecha,
        proveedor: grupo[0]!.proveedor,
        tc,
      });
    }
    return resultado;
  }

  async function onArchivos(files: File[]) {
    setCargando(true);
    setAviso(null);
    const seleccionados = files.map((file) => ({ key: nextKey(), file }));
    const gastos: Array<GastoLegalizado & { archivoKey: string; archivoNombre: string }> = [];
    const errores: string[] = [];
    for (const archivo of seleccionados) {
      try {
        const leidos = await parseLegalizacionExcel(archivo.file);
        if (leidos.length === 0) errores.push(`${archivo.file.name}: sin gastos legibles`);
        gastos.push(
          ...leidos.map((g) => ({
            ...g,
            archivoKey: archivo.key,
            archivoNombre: archivo.file.name,
          })),
        );
      } catch (e) {
        errores.push(
          `${archivo.file.name}: ${e instanceof Error ? e.message : "error desconocido"}`,
        );
      }
    }
    setArchivos(seleccionados);
    setDescartadas(new Set());
    if (gastos.length === 0) {
      setAviso(
        errores.length
          ? `No se encontraron gastos. ${errores.join(" · ")}`
          : "No se encontraron gastos legalizados en los archivos. Revisa el formato.",
      );
      setFilas([]);
      setSugerencias([]);
    } else {
      const nuevasFilas = construirFilas(gastos);
      setFilas(nuevasFilas);
      setSugerencias(recalcularSugerencias(nuevasFilas, new Set()));
      const sinTc = gastos.filter((g) => !g.tc).length;
      setAviso(
        `${seleccionados.length} archivo${seleccionados.length === 1 ? "" : "s"} procesado${seleccionados.length === 1 ? "" : "s"}. ${gastos.length} gastos leídos.` +
          (sinTc ? ` ${sinTc} sin TC detectado: escríbelo antes de confirmar.` : "") +
          (errores.length ? ` Problemas: ${errores.join(" · ")}` : ""),
      );
    }
    setCargando(false);
  }

  function cambiarTc(key: string, tc: string) {
    setFilas((prev) => {
      const next = prev.map((f) => {
        if (f.key !== key) return f;
        const cands = candidatosPara(tc, f);
        return { ...f, tc, candidatos: cands, cruceId: cands[0]?.id ?? "" };
      });
      setSugerencias(recalcularSugerencias(next, descartadas));
      return next;
    });
  }

  function aceptarSugerencia(s: Sugerencia) {
    setFilas((prev) => {
      const miembros = prev.filter((f) => s.filaKeys.includes(f.key));
      const resto = prev.filter((f) => !s.filaKeys.includes(f.key));
      const fusionada: FilaLegal = {
        key: nextKey(),
        archivoKeys: [...new Set(miembros.flatMap((f) => f.archivoKeys))],
        archivoNombre: miembros[0]?.archivoNombre ?? "",
        tc: s.tc,
        fecha: s.fecha,
        proveedor: s.proveedor,
        valor: s.valorSuma,
        cruceId: s.pendienteId,
        candidatos: pendientes.filter((m) => m.id === s.pendienteId),
        grupo: miembros.length,
      };
      const next = [...resto, fusionada];
      setSugerencias(recalcularSugerencias(next, descartadas));
      return next;
    });
  }

  function rechazarSugerencia(s: Sugerencia) {
    setDescartadas((prev) => {
      const next = new Set(prev);
      next.add(s.id);
      return next;
    });
    setSugerencias((prev) => prev.filter((x) => x.id !== s.id));
  }

  async function confirmar() {
    const cruces = filas.filter((f) => f.cruceId);
    if (cruces.length === 0 || archivos.length === 0) return;
    setGuardando(true);
    try {
      const urls = new Map<string, string>();
      const keysNecesarios = new Set(cruces.flatMap((f) => f.archivoKeys));
      for (const archivo of archivos) {
        if (!keysNecesarios.has(archivo.key)) continue;
        const { url } = await subirArchivoLegalizacion(
          `${hoyISO()}_${archivo.file.name}`,
          archivo.file,
        );
        urls.set(archivo.key, url);
      }

      for (const f of cruces) {
        const url = f.archivoKeys.map((k) => urls.get(k)).find(Boolean);
        if (!url) continue;
        await actualizarMovimiento(f.cruceId, {
          estado: "Legalizado",
          fecha_legalizacion: f.fecha,
          proveedor_legalizacion: f.proveedor || null,
          archivo_legalizacion_url: url,
        });
      }
      await qc.invalidateQueries({ queryKey: movimientosQuery.queryKey });
      setFilas([]);
      setSugerencias([]);
      setArchivos([]);
      setAviso(`Se legalizaron ${cruces.length} movimientos y se guardaron sus soportes.`);
    } catch (e) {
      setAviso(`No se pudo completar: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="1. Excel de legalización">
        <input
          type="file"
          multiple
          accept=".xlsx,.xls"
          className="text-[13px]"
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            if (fs.length) void onArchivos(fs);
          }}
        />
        {cargando ? <p className="mt-3 text-muted-foreground">Leyendo hojas…</p> : null}
        {aviso ? (
          <p className="mt-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
            {aviso}
          </p>
        ) : null}
      </Card>

      {sugerencias.length > 0 ? (
        <Card title="Posibles gastos compartidos (revisa y confirma)">
          <div className="space-y-3">
            {sugerencias.map((s) => (
              <div
                key={s.id}
                className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]"
              >
                <p>
                  <strong>{s.filaKeys.length} filas</strong> de {formatFecha(s.fecha)} ·{" "}
                  {s.proveedor || "—"} (TC {s.tc}) suman{" "}
                  <strong>{formatCOP(s.valorSuma)}</strong>, que coincide con el pendiente{" "}
                  <strong>
                    {formatFecha(s.pendienteFecha)} · {s.pendienteDesc} ·{" "}
                    {formatCOP(s.pendienteValor)}
                  </strong>
                  . ¿Es un gasto compartido entre varias personas?
                </p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className={btnPrimary} onClick={() => aceptarSugerencia(s)}>
                    Sí, es el mismo gasto
                  </button>
                  <button type="button" className={btnGhost} onClick={() => rechazarSugerencia(s)}>
                    No, son gastos distintos
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {filas.length > 0 ? (
        <Card title="2. Confirma el cruce contra pendientes">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-semibold">TC</th>
                  <th className="px-2 py-2 font-semibold">Archivo</th>
                  <th className="px-2 py-2 font-semibold">Fecha</th>
                  <th className="px-2 py-2 font-semibold">Proveedor</th>
                  <th className="px-2 py-2 text-right font-semibold">Valor</th>
                  <th className="px-2 py-2 font-semibold">Pendiente a cruzar</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr
                    key={f.key}
                    className={`border-t border-border ${
                      f.candidatos.length === 0 ? "bg-destructive/5" : ""
                    }`}
                  >
                    <td className="px-2 py-1.5">
                      <input
                        className={`${inputCls} w-20`}
                        value={f.tc}
                        onChange={(e) => cambiarTc(f.key, e.target.value)}
                      />
                    </td>
                    <td className="max-w-[180px] truncate px-2 py-1.5 text-[12px]" title={f.archivoNombre}>
                      {f.archivoNombre}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{formatFecha(f.fecha)}</td>
                    <td className="px-2 py-1.5">
                      {f.proveedor || "—"}
                      {f.grupo > 1 ? (
                        <span className="ml-1 rounded-full bg-accent px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-foreground">
                          {f.grupo} personas
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(f.valor)}</td>
                    <td className="px-2 py-1.5">
                      {f.candidatos.length === 0 ? (
                        <span className="text-[12.5px] font-medium text-destructive">
                          Sin pendiente parecido en esa TC
                        </span>
                      ) : (
                        <select
                          className={`${inputCls} min-w-[320px]`}
                          value={f.cruceId}
                          onChange={(e) =>
                            setFilas((prev) =>
                              prev.map((x) =>
                                x.key === f.key ? { ...x, cruceId: e.target.value } : x,
                              ),
                            )
                          }
                        >
                          <option value="">— Sin cruce —</option>
                          {f.candidatos.map((c) => (
                            <option key={c.id} value={c.id}>
                              {formatFecha(c.fecha)} · {c.descripcion} · {formatCOP(c.valor)}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className={`${btnPrimary} mt-4`}
            disabled={guardando || filas.filter((f) => f.cruceId).length === 0}
            onClick={() => void confirmar()}
          >
            {guardando
              ? "Guardando…"
              : `Confirmar legalización (${filas.filter((f) => f.cruceId).length})`}
          </button>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------- Modo C ------------------------------- */

function filaManualVacia(tc = ""): FilaPrev {
  return {
    key: nextKey(),
    tc,
    banco: "Davivienda",
    fecha: hoyISO(),
    doc: null,
    descripcion: "",
    valor: 0,
    tipo: "Consumo",
    moneda: "COP",
    valorOriginal: null,
    trm: null,
    duplicado: false,
    incluir: true,
  };
}

function ModoManual() {
  const qc = useQueryClient();
  const { data: movs } = useQuery(movimientosQuery);
  const [filas, setFilas] = useState<FilaPrev[]>([filaManualVacia()]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const tcs = useMemo(
    () => [...new Set((movs ?? []).map((m) => m.tc))].sort((a, b) => a.localeCompare(b)),
    [movs],
  );

  function actualizar(key: string, patch: Partial<FilaPrev>) {
    setFilas((prev) =>
      prev.map((f) => {
        if (f.key !== key) return f;
        const next = { ...f, ...patch };
        if (patch.descripcion !== undefined) next.tipo = clasificar(patch.descripcion);
        return next;
      }),
    );
  }

  async function guardar() {
    const validas = filas.filter((f) => f.tc.trim() && f.descripcion.trim() && f.valor !== 0);
    if (validas.length === 0) {
      setAviso("Completa al menos una fila con TC, descripción y valor.");
      return;
    }
    const marcadas = marcarDuplicados(validas, movs ?? []);
    const dups = marcadas.filter((f) => f.duplicado);
    if (dups.length > 0 && !filas.some((f) => f.duplicado)) {
      setFilas(marcadas);
      setAviso(
        `${dups.length} fila(s) parecen repetidas (misma TC, fecha, valor y descripción) y quedaron sin marcar. Revisa y vuelve a guardar.`,
      );
      return;
    }
    setGuardando(true);
    try {
      const rows: NuevoMovimiento[] = marcadas
        .filter((f) => f.incluir)
        .map((f) => ({
          tc: f.tc.trim(),
          banco: f.banco,
          fecha: f.fecha,
          doc: f.doc,
          descripcion: f.descripcion.trim(),
          valor: f.valor,
          tipo: f.tipo,
          estado: estadoInicial(f.tipo),
        }));
      if (rows.length === 0) {
        setAviso("No hay filas seleccionadas para guardar.");
        return;
      }
      await insertarMovimientos(rows);
      await qc.invalidateQueries({ queryKey: movimientosQuery.queryKey });
      setFilas([filaManualVacia()]);
      setAviso(`Se guardaron ${rows.length} movimientos.`);
    } catch (e) {
      setAviso(`No se pudo guardar: ${e instanceof Error ? e.message : "error"}`);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Card title="Movimientos manuales">
      {aviso ? (
        <p className="mb-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          {aviso}
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-table-head text-left text-[12px] uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-2 py-2">Inc.</th>
              <th className="px-2 py-2 font-semibold">TC</th>
              <th className="px-2 py-2 font-semibold">Banco</th>
              <th className="px-2 py-2 font-semibold">Fecha</th>
              <th className="px-2 py-2 font-semibold">Descripción</th>
              <th className="px-2 py-2 font-semibold">Valor</th>
              <th className="px-2 py-2 font-semibold">Tipo</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.key} className={`border-t border-border ${f.duplicado ? "bg-muted/60" : ""}`}>
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Incluir fila"
                    checked={f.incluir}
                    onChange={(e) => actualizar(f.key, { incluir: e.target.checked })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={`${inputCls} w-24`}
                    list="tc-existentes"
                    value={f.tc}
                    onChange={(e) => actualizar(f.key, { tc: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    className={`${inputCls} w-36`}
                    value={f.banco}
                    onChange={(e) => actualizar(f.key, { banco: e.target.value })}
                  >
                    <option value="Davivienda">Davivienda</option>
                    <option value="Bancolombia">Bancolombia</option>
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="date"
                    className={`${inputCls} w-36`}
                    value={f.fecha}
                    onChange={(e) => actualizar(f.key, { fecha: e.target.value })}
                  />
                </td>
                <td className="min-w-[240px] px-2 py-1.5">
                  <input
                    className={inputCls}
                    value={f.descripcion}
                    onChange={(e) => actualizar(f.key, { descripcion: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={`${inputCls} w-32 text-right tabular-nums`}
                    value={String(f.valor)}
                    onChange={(e) => actualizar(f.key, { valor: parseCOP(e.target.value) })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <select
                    className={`${inputCls} w-44`}
                    value={f.tipo}
                    onChange={(e) => actualizar(f.key, { tipo: e.target.value as Tipo })}
                  >
                    <option value="Consumo">Consumo</option>
                    <option value="Movimiento Bancario">Movimiento Bancario</option>
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  {filas.length > 1 ? (
                    <button
                      type="button"
                      className="text-[12px] text-destructive underline"
                      onClick={() => setFilas((prev) => prev.filter((x) => x.key !== f.key))}
                    >
                      Quitar
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="tc-existentes">
          {tcs.map((tc) => (
            <option key={tc} value={tc} />
          ))}
        </datalist>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className={btnGhost}
          onClick={() => setFilas((prev) => [...prev, filaManualVacia(prev.at(-1)?.tc ?? "")])}
        >
          + Agregar otra fila
        </button>
        <button
          type="button"
          className={btnPrimary}
          disabled={guardando}
          onClick={() => void guardar()}
        >
          {guardando ? "Guardando…" : "Guardar movimientos"}
        </button>
      </div>
    </Card>
  );
}
