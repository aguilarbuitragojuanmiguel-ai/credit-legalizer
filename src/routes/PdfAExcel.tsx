import { useState } from "react";

import { AppShell, Card } from "@/components/AppShell";
import { clasificar, formatCOP, formatFecha } from "@/lib/format";
import { parseBancolombiaPdf } from "@/lib/parsers/bancolombia-pdf";
import { parseBancoBogotaPdf } from "@/lib/parsers/bancodebogota-pdf";
import { parseDaviviendaPdf } from "@/lib/parsers/davivienda";

type Banco = "auto" | "Bancolombia" | "Davivienda" | "Banco de Bogotá";

type Fila = {
  tc: string;
  fecha: string;
  doc: string;
  descripcion: string;
  valor: number;
  moneda: "COP" | "USD";
  tipo: string;
};

type Leido = { archivo: string; banco: string; tc: string; filas: Fila[] };

const inputCls =
  "rounded border border-input bg-card px-2 py-1.5 text-[13px] outline-none focus:border-ring";

export async function leer(file: File, banco: Banco): Promise<Leido> {
  const probar = async (b: Exclude<Banco, "auto">): Promise<Leido> => {
    if (b === "Davivienda") {
      const r = await parseDaviviendaPdf(file);
      const tc = r.tc ?? "";
      return {
        archivo: file.name,
        banco: b,
        tc,
        filas: r.filas.map((f) => ({
          tc,
          fecha: f.fecha,
          doc: f.doc ?? "",
          descripcion: f.descripcion,
          valor: f.valor,
          moneda: "COP",
          tipo: clasificar(f.descripcion),
        })),
      };
    }
    if (b === "Banco de Bogotá") {
      const r = await parseBancoBogotaPdf(file);
      const tc = r.tc ?? "";
      return {
        archivo: file.name,
        banco: b,
        tc,
        filas: r.filas.map((f) => ({
          tc,
          fecha: f.fecha,
          doc: f.doc ?? "",
          descripcion: f.descripcion,
          valor: f.valor,
          moneda: "COP",
          tipo: clasificar(f.descripcion),
        })),
      };
    }
    const r = await parseBancolombiaPdf(file);
    const tc = r.tc ?? "";
    return {
      archivo: file.name,
      banco: "Bancolombia",
      tc,
      filas: r.filas.map((f) => ({
        tc,
        fecha: f.fecha,
        doc: "",
        descripcion: f.descripcion,
        valor: f.valor,
        moneda: f.moneda,
        tipo: clasificar(f.descripcion),
      })),
    };
  };

  if (banco !== "auto") return probar(banco);
  // Automático: se prueba con cada lector y se queda el que más filas lee
  let mejor: Leido | null = null;
  for (const b of ["Bancolombia", "Davivienda", "Banco de Bogotá"] as const) {
    try {
      const r = await probar(b);
      if (!mejor || r.filas.length > mejor.filas.length) mejor = r;
    } catch {
      /* ese lector no pudo con el archivo: se sigue con el siguiente */
    }
  }
  return mejor ?? { archivo: file.name, banco: "—", tc: "", filas: [] };
}

function nombreHoja(txt: string, usados: Set<string>): string {
  let base = txt.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Hoja";
  let n = base;
  let i = 2;
  while (usados.has(n.toLowerCase())) n = `${base.slice(0, 26)} ${i++}`;
  usados.add(n.toLowerCase());
  return n;
}

type FilaUnida = Fila & { archivo: string; banco: string };

/**
 * Junta todos los archivos en una sola lista. Si dos PDF se traslapan (semanas que repiten
 * días), el mismo movimiento no se cuenta dos veces: de cada movimiento idéntico se conserva
 * la mayor cantidad que trae UN solo archivo, así las compras iguales del mismo día se respetan.
 */
export function unir(leidos: Leido[]): { filas: FilaUnida[]; repetidos: number } {
  const clave = (tc: string, f: Fila) =>
    [tc, f.fecha, f.doc, f.descripcion.toUpperCase(), f.valor.toFixed(2), f.moneda].join("|");
  const maxPorClave = new Map<string, number>();
  for (const l of leidos) {
    const conteo = new Map<string, number>();
    for (const f of l.filas) {
      const k = clave(f.tc || l.tc, f);
      conteo.set(k, (conteo.get(k) ?? 0) + 1);
    }
    for (const [k, n] of conteo) maxPorClave.set(k, Math.max(maxPorClave.get(k) ?? 0, n));
  }
  const usados = new Map<string, number>();
  const filas: FilaUnida[] = [];
  let total = 0;
  for (const l of leidos) {
    for (const f of l.filas) {
      total += 1;
      const k = clave(f.tc || l.tc, f);
      const n = usados.get(k) ?? 0;
      if (n >= (maxPorClave.get(k) ?? 0)) continue;
      usados.set(k, n + 1);
      filas.push({ ...f, tc: f.tc || l.tc, archivo: l.archivo, banco: l.banco });
    }
  }
  filas.sort((a, b) => a.tc.localeCompare(b.tc) || a.fecha.localeCompare(b.fecha));
  return { filas, repetidos: total - filas.length };
}

/** Fecha ISO -> número de serie de Excel (solo fecha, sin hora) */
function serialExcel(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
}

export async function descargar(leidos: Leido[]) {
  const XLSX = await import("xlsx");
  const cab = ["Archivo", "Banco", "TC", "Fecha", "Doc", "Descripción", "Valor", "Moneda", "Tipo"];
  const aFila = (f: FilaUnida) => [
    f.archivo,
    f.banco,
    f.tc,
    serialExcel(f.fecha),
    f.doc,
    f.descripcion,
    f.valor,
    f.moneda,
    f.tipo,
  ];
  const hoja = (filas: unknown[][]) => {
    const ws = XLSX.utils.aoa_to_sheet([cab, ...filas]);
    ws["!cols"] = [
      { wch: 26 }, { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 42 }, { wch: 16 }, { wch: 8 }, { wch: 20 },
    ];
    const rango = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
    for (let r = 1; r <= rango.e.r; r++) {
      const fecha = ws[XLSX.utils.encode_cell({ r, c: 3 })];
      if (fecha) fecha.z = "dd/mm/yyyy";
      const valor = ws[XLSX.utils.encode_cell({ r, c: 6 })];
      if (valor) valor.z = "#,##0.00";
    }
    return ws;
  };

  const wb = XLSX.utils.book_new();
  const usados = new Set<string>();
  const { filas } = unir(leidos);
  XLSX.utils.book_append_sheet(wb, hoja(filas.map(aFila)), nombreHoja("Movimientos", usados));
  // Una hoja por tarjeta cuando hay más de una
  const porTC = new Map<string, FilaUnida[]>();
  for (const f of filas) porTC.set(`${f.banco} ${f.tc}`, [...(porTC.get(`${f.banco} ${f.tc}`) ?? []), f]);
  if (porTC.size > 1) {
    for (const [nombreTC, lista] of porTC) {
      XLSX.utils.book_append_sheet(wb, hoja(lista.map(aFila)), nombreHoja(nombreTC, usados));
    }
  }
  const nombre =
    leidos.length === 1
      ? `${leidos[0]!.archivo.replace(/\.pdf$/i, "")}.xlsx`
      : "movimientos_pdf.xlsx";
  XLSX.writeFile(wb, nombre);
}

export default function PdfAExcel() {
  const [banco, setBanco] = useState<Banco>("auto");
  const [leidos, setLeidos] = useState<Leido[]>([]);
  const [leyendo, setLeyendo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onArchivos = async (files: File[]) => {
    setError(null);
    setLeyendo(true);
    const out: Leido[] = [];
    const fallos: string[] = [];
    for (const f of files) {
      try {
        const r = await leer(f, banco);
        if (r.filas.length === 0) fallos.push(`${f.name}: no encontré movimientos (¿es el banco correcto?)`);
        else out.push(r);
      } catch {
        fallos.push(`${f.name}: no se pudo leer el PDF`);
      }
    }
    setLeidos((prev) => [...prev.filter((p) => !out.some((o) => o.archivo === p.archivo)), ...out]);
    setError(fallos.length ? fallos.join(" · ") : null);
    setLeyendo(false);
  };

  const unido = unir(leidos);
  const total = unido.filas.length;

  return (
    <AppShell>
      <h1 className="mb-4 text-[18px] font-semibold tracking-tight">PDF a Excel</h1>
      <Card title="Convierte los movimientos de un PDF del banco en Excel">
        <p className="mb-3 text-[13px] text-muted-foreground">
          Sube uno o varios PDF de movimientos (Bancolombia, Davivienda o Banco de Bogotá; puedes agregar
          más en varias tandas) y descarga un solo Excel con la fecha, descripción, valor y tipo. Es solo conversión: no guarda nada en la app.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className={inputCls}
            value={banco}
            onChange={(e) => setBanco(e.target.value as Banco)}
          >
            <option value="auto">Banco: detectar automático</option>
            <option value="Bancolombia">Bancolombia</option>
            <option value="Davivienda">Davivienda</option>
            <option value="Banco de Bogotá">Banco de Bogotá</option>
          </select>
          <input
            type="file"
            accept=".pdf"
            multiple
            className="text-[13px]"
            onChange={(e) => {
              const fs = Array.from(e.target.files ?? []);
              if (fs.length) void onArchivos(fs);
            }}
          />
          {leyendo ? <span className="text-[13px] text-muted-foreground">Leyendo…</span> : null}
        </div>
        {error ? <p className="mt-3 text-[12px] text-destructive">{error}</p> : null}
      </Card>

      {leidos.length > 0 ? (
        <div className="mt-5">
          <Card title={`${total} movimiento${total === 1 ? "" : "s"} leído${total === 1 ? "" : "s"}`}>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void descargar(leidos)}
                className="rounded bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground"
              >
                Descargar Excel (todos los archivos juntos)
              </button>
              <button
                type="button"
                onClick={() => {
                  setLeidos([]);
                  setError(null);
                }}
                className="rounded border border-input bg-card px-3 py-1.5 text-[13px] font-semibold"
              >
                Limpiar
              </button>
              <span className="text-[12px] text-muted-foreground">
                {leidos.length} archivo{leidos.length === 1 ? "" : "s"}
                {unido.repetidos > 0
                  ? ` · ${unido.repetidos} movimiento${unido.repetidos === 1 ? "" : "s"} repetido${unido.repetidos === 1 ? "" : "s"} entre archivos (no se duplican)`
                  : ""}
              </span>
            </div>
            {leidos.map((l) => (
              <div key={l.archivo} className="mb-5">
                <p className="mb-1 text-[12px] font-semibold text-muted-foreground">
                  {l.archivo} · {l.banco}
                  {l.tc ? ` · TC ${l.tc}` : ""} · {l.filas.length} filas
                </p>
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full text-[13px]">
                    <thead className="bg-table-head text-left text-[12px] text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2">Fecha</th>
                        <th className="px-2 py-2">Doc</th>
                        <th className="px-2 py-2">Descripción</th>
                        <th className="px-2 py-2 text-right">Valor</th>
                        <th className="px-2 py-2">Moneda</th>
                        <th className="px-2 py-2">Tipo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l.filas.map((f, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-2 py-1.5 whitespace-nowrap">{formatFecha(f.fecha)}</td>
                          <td className="px-2 py-1.5">{f.doc}</td>
                          <td className="px-2 py-1.5">{f.descripcion}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {f.moneda === "USD"
                              ? `USD ${f.valor.toLocaleString("es-CO", { minimumFractionDigits: 2 })}`
                              : formatCOP(f.valor)}
                          </td>
                          <td className="px-2 py-1.5">{f.moneda}</td>
                          <td className="px-2 py-1.5">{f.tipo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </Card>
        </div>
      ) : null}
    </AppShell>
  );
}
