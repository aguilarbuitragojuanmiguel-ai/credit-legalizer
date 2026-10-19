/**
 * Lee el extracto mensual (estado de cuenta) de una tarjeta de crédito en PDF.
 * Soporta Bancolombia (secciones PESOS / DOLARES) y Davivienda.
 * Parte pura (sin pdf.js) para poder probarla en Node: parseExtractoItems.
 */

export type ItemTexto = { str: string; x: number; y: number };

export type TipoFilaExtracto = "compra" | "abono" | "cargo_bancario";

export type FilaExtracto = {
  /** ISO yyyy-mm-dd */
  fecha: string;
  descripcion: string;
  /** En la moneda del extracto: positivo = cargo, negativo = abono */
  valor: number;
  tipo: TipoFilaExtracto;
  doc: string | null;
};

export type ValidacionExtracto = {
  nombre: string;
  esperado: number;
  leido: number;
  ok: boolean;
};

export type SeccionExtracto = {
  moneda: "COP" | "USD";
  periodoDesde: string | null;
  /** Fecha de corte (fin del período facturado), ISO */
  fechaCorte: string | null;
  saldoAnterior: number;
  compras: number;
  interesesMora: number;
  interesesCorrientes: number;
  avances: number;
  otrosCargos: number;
  pagos: number;
  saldoAFavor: number;
  /** Saldo total a pagar según el resumen del extracto */
  saldoTotal: number;
  filas: FilaExtracto[];
  validaciones: ValidacionExtracto[];
};

export type ResultadoExtracto = {
  banco: "Bancolombia" | "Davivienda" | null;
  /** Últimos 4 dígitos */
  tc: string | null;
  secciones: SeccionExtracto[];
};

/* ---------- utilidades ---------- */

function agruparLineas(items: ItemTexto[]): string[] {
  const orden = [...items]
    .filter((i) => i.str.trim() !== "")
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lineas: ItemTexto[][] = [];
  let yActual = Number.POSITIVE_INFINITY;
  for (const it of orden) {
    if (lineas.length === 0 || Math.abs(it.y - yActual) > 2.5) {
      lineas.push([it]);
      yActual = it.y;
    } else {
      lineas[lineas.length - 1]?.push(it);
    }
  }
  return lineas.map((l) =>
    l
      .sort((a, b) => a.x - b.x)
      .map((i) => i.str)
      .join(" ")
      .replace(/[​‌‍⁠﻿]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/** "1,248.16" -> 1248.16 ; "267,029.00-" -> -267029 ; "0.75-" -> -0.75 */
function numeroEN(raw: string): number {
  const negativo = raw.trim().endsWith("-") || raw.trim().startsWith("-");
  const n = parseFloat(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return negativo ? -n : n;
}

const NUM_EN = String.raw`(-?[\d,]+\.\d{2}-?)`;

function tomar(txt: string, re: RegExp): number | null {
  const m = txt.match(re);
  return m ? numeroEN(m[1] ?? "0") : null;
}

function fechaDMY(s: string): string | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const CARGO_BANCARIO_RE =
  /GMF|IMP\s*4\s*X\s*MIL|4\s*X\s*1000|CUOTA DE MANEJO|INTERES|IVA\b|COMISION|COBRO\s+(?:POR|REEXP)|REEXPEDICION/i;

function clasificar(descripcion: string, valor: number): TipoFilaExtracto {
  if (valor < 0 || /^(PAGO|ABONO)\b/i.test(descripcion)) return "abono";
  if (CARGO_BANCARIO_RE.test(descripcion)) return "cargo_bancario";
  return "compra";
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function validar(sec: SeccionExtracto): ValidacionExtracto[] {
  const v: ValidacionExtracto[] = [];
  const suma = (tipo: TipoFilaExtracto) =>
    r2(sec.filas.filter((f) => f.tipo === tipo).reduce((s, f) => s + f.valor, 0));
  const tol = sec.moneda === "USD" ? 0.05 : 1;
  const push = (nombre: string, esperado: number, leido: number) =>
    v.push({ nombre, esperado: r2(esperado), leido: r2(leido), ok: Math.abs(esperado - leido) <= tol });

  push("Compras del extracto = suma de las compras leídas", sec.compras, suma("compra"));
  push(
    "Otros cargos + intereses = suma de cargos bancarios leídos",
    sec.otrosCargos + sec.interesesCorrientes + sec.interesesMora,
    suma("cargo_bancario"),
  );
  push("Pagos del extracto = suma de abonos leídos", sec.pagos, -suma("abono"));
  push(
    "Saldo anterior + movimientos − pagos = saldo total",
    sec.saldoTotal - sec.saldoAFavor,
    sec.saldoAnterior +
      sec.compras +
      sec.avances +
      sec.otrosCargos +
      sec.interesesCorrientes +
      sec.interesesMora -
      sec.pagos,
  );
  return v;
}

/* ---------- Bancolombia ---------- */

function parseBancolombia(lineasPorPagina: string[][]): ResultadoExtracto {
  const todas = lineasPorPagina.flat();
  const tc = todas.join("\n").match(/\*{3,}\s*(\d{4})/)?.[1] ?? null;

  const secciones = new Map<"COP" | "USD", SeccionExtracto>();
  let actual: SeccionExtracto | null = null;
  let enResumen = false;

  const vacia = (moneda: "COP" | "USD"): SeccionExtracto => ({
    moneda,
    periodoDesde: null,
    fechaCorte: null,
    saldoAnterior: 0,
    compras: 0,
    interesesMora: 0,
    interesesCorrientes: 0,
    avances: 0,
    otrosCargos: 0,
    pagos: 0,
    saldoAFavor: 0,
    saldoTotal: 0,
    filas: [],
    validaciones: [],
  });

  for (const linea of todas) {
    const hdr = linea.match(/ESTADO DE CUENTA EN:\s*(PESOS|DOLARES|DÓLARES)/i);
    if (hdr) {
      const moneda = /PESOS/i.test(hdr[1] ?? "") ? "COP" : "USD";
      let s = secciones.get(moneda);
      if (!s) {
        s = vacia(moneda);
        secciones.set(moneda, s);
        enResumen = true;
      } else {
        enResumen = false;
      }
      actual = s;
      continue;
    }
    if (!actual) continue;

    const per = linea.match(
      /desde:?\s*(\d{2}\/\d{2}\/\d{4})\s+hasta:?\s*(\d{2}\/\d{2}\/\d{4})/i,
    );
    if (per && !actual.fechaCorte) {
      actual.periodoDesde = fechaDMY(per[1] ?? "");
      actual.fechaCorte = fechaDMY(per[2] ?? "");
    }

    if (enResumen) {
      const set = <K extends keyof SeccionExtracto>(k: K, re: RegExp) => {
        const n = tomar(linea, re);
        if (n !== null) (actual as SeccionExtracto)[k] = n as never;
      };
      set("saldoAnterior", new RegExp(String.raw`Saldo anterior\s+${NUM_EN}`, "i"));
      set("compras", new RegExp(String.raw`\+\s*Compras del mes\s+${NUM_EN}`, "i"));
      set("interesesMora", new RegExp(String.raw`\+\s*Intereses de mora\s+${NUM_EN}`, "i"));
      set("interesesCorrientes", new RegExp(String.raw`\+\s*Intereses corrientes\s+${NUM_EN}`, "i"));
      set("avances", new RegExp(String.raw`\+\s*Avances\s+${NUM_EN}`, "i"));
      set("otrosCargos", new RegExp(String.raw`\+\s*Otros cargos\s+${NUM_EN}`, "i"));
      set("pagos", new RegExp(String.raw`-\s*Pagos\s*\/\s*abonos\s+${NUM_EN}`, "i"));
      set("saldoAFavor", new RegExp(String.raw`(?:^|\s)Saldo a favor\s+${NUM_EN}`, "i"));
      set("saldoTotal", new RegExp(String.raw`=\s*Pagos total\s+${NUM_EN}`, "i"));
    }

    // Fila de movimiento: [autorización] dd/mm/yyyy DESCRIPCIÓN valorOriginal ...
    const m = linea.match(/^(?:(\S+)\s+)?(\d{2}\/\d{2}\/\d{4})\s+(.+)$/);
    if (m) {
      const fecha = fechaDMY(m[2] ?? "");
      const resto = m[3] ?? "";
      const nm = resto.match(new RegExp(String.raw`^(.*?)\s+${NUM_EN}(?:\s|$)`));
      if (fecha && nm && (nm[1] ?? "").trim() !== "") {
        const descripcion = (nm[1] ?? "").trim();
        const valor = numeroEN(nm[2] ?? "0");
        actual.filas.push({
          fecha,
          descripcion,
          valor: valor,
          tipo: clasificar(descripcion, valor),
          doc: m[1] ?? null,
        });
        enResumen = false;
      }
    }
  }

  const lista = [...secciones.values()];
  for (const s of lista) s.validaciones = validar(s);
  return { banco: "Bancolombia", tc, secciones: lista };
}

/* ---------- Davivienda ---------- */

const MES_ABR: Record<string, string> = {
  ENE: "01",
  FEB: "02",
  MAR: "03",
  ABR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AGO: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DIC: "12",
};

function parseDavivienda(lineasPorPagina: string[][]): ResultadoExtracto {
  const todas = lineasPorPagina.flat();
  const texto = todas.join("\n");
  const tc =
    texto.match(/Tarjeta de Cr[eé]dito\s*#\s*(?:\d{4}\s+){3}(\d{4})/i)?.[1] ??
    texto.match(/\*{3,}\s*(\d{4})/)?.[1] ??
    null;

  const sec: SeccionExtracto = {
    moneda: "COP",
    periodoDesde: null,
    fechaCorte: null,
    saldoAnterior: 0,
    compras: 0,
    interesesMora: 0,
    interesesCorrientes: 0,
    avances: 0,
    otrosCargos: 0,
    pagos: 0,
    saldoAFavor: 0,
    saldoTotal: 0,
    filas: [],
    validaciones: [],
  };

  const per = texto.match(
    /([A-Z]{3})\.(\d{1,2})\/(\d{2})\s*-\s*([A-Z]{3})\.(\d{1,2})\/(\d{2})/,
  );
  if (per) {
    const mes1 = MES_ABR[per[1] ?? ""];
    const mes2 = MES_ABR[per[4] ?? ""];
    if (mes1)
      sec.periodoDesde = `20${per[3]}-${mes1}-${String(per[2]).padStart(2, "0")}`;
    if (mes2) sec.fechaCorte = `20${per[6]}-${mes2}-${String(per[5]).padStart(2, "0")}`;
  }

  const ent = (label: string) => {
    const m = texto.match(new RegExp(String.raw`^${label}\s+\$\s*([\d,]+)`, "im"));
    return m ? parseFloat((m[1] ?? "0").replace(/,/g, "")) : 0;
  };
  sec.saldoAnterior = ent("Saldo anterior");
  sec.compras = ent("Consumos mes");
  sec.interesesCorrientes = ent("Intereses corrientes");
  sec.interesesMora = ent("Intereses de mora");
  sec.otrosCargos = ent("Otros cargos") + ent("Cuota de manejo");
  sec.pagos = ent("Pagos mes");
  sec.saldoTotal = ent("Saldo total");

  const ROW =
    /^(\d{5,})\s+(\d{8})\s+(.+?)\s+\$\s*([\d,]+)\s+\$\s*([\d,]+)([+-])/;
  for (const linea of todas) {
    const m = linea.match(ROW);
    if (!m) continue;
    const f = m[2] ?? "";
    const fecha = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}`;
    const descripcion = (m[3] ?? "").trim();
    const valorAbs = parseFloat((m[4] ?? "0").replace(/,/g, ""));
    const esAbono = m[6] === "-" || /^(PAGO|ABONO)\b/i.test(descripcion);
    const valor = esAbono ? -valorAbs : valorAbs;
    sec.filas.push({
      fecha,
      descripcion,
      valor,
      tipo: clasificar(descripcion, valor),
      doc: m[1] ?? null,
    });
  }

  sec.validaciones = validar(sec);
  return { banco: "Davivienda", tc, secciones: [sec] };
}

/* ---------- API ---------- */

export function parseExtractoItems(paginas: { items: ItemTexto[] }[]): ResultadoExtracto {
  const lineasPorPagina = paginas.map((p) => agruparLineas(p.items));
  const todo = lineasPorPagina.flat().join("\n");
  if (/ESTADO DE CUENTA EN:|Bancolombia/i.test(todo)) return parseBancolombia(lineasPorPagina);
  if (/Davivienda|Periodo liquidado/i.test(todo)) return parseDavivienda(lineasPorPagina);
  return { banco: null, tc: null, secciones: [] };
}

/** Lee un extracto de tarjeta en PDF en el navegador. */
export async function parseExtractoPDF(file: File): Promise<ResultadoExtracto> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const paginas: { items: ItemTexto[] }[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: ItemTexto[] = [];
    for (const it of content.items as { str?: string; transform?: number[] }[]) {
      if (typeof it.str !== "string" || !it.transform) continue;
      items.push({ str: it.str, x: it.transform[4] ?? 0, y: it.transform[5] ?? 0 });
    }
    paginas.push({ items });
  }
  return parseExtractoItems(paginas);
}
