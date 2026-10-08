import { formatFecha } from "./format";

export type GastoPDF = {
  tc: string;
  fecha: string;
  descripcion: string;
  valor: number;
};

/** 1800456 -> "1.800.456" (siempre con punto de miles, también en 4 dígitos) */
function miles(n: number, decimales = 0): string {
  const neg = n < 0;
  const fijo = Math.abs(n).toFixed(decimales);
  const [ent = "0", dec] = fijo.split(".");
  const conPuntos = ent.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${neg ? "-" : ""}${conPuntos}${dec ? `,${dec}` : ""}`;
}

const VERDE: [number, number, number] = [169, 208, 142];

/**
 * Genera el PDF "Relación de gastos no deducibles": título en caja, bloques
 * por TC en dos columnas (etiqueta verde, filas fecha/descripción/valor y
 * TOTAL) y SALDO TOTAL al final. Hoja carta vertical.
 */
export async function generarActaFiscalPDF(
  titulo: string,
  gastos: GastoPDF[],
  responsables: Record<string, string> = {},
) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "letter" });

  const PAG_W = 612;
  const PAG_H = 792;
  const MARGEN = 36;
  const GAP = 14;
  const COL_W = (PAG_W - MARGEN * 2 - GAP) / 2;
  const FUENTE = 7.5;
  const LINEA = 9;
  const PAD = 3;
  const FECHA_W = 50;
  const VALOR_W = 52;
  const DESC_W = COL_W - FECHA_W - VALOR_W - PAD * 2;
  const TAG_H = 12;
  const TOTAL_H = 16;

  doc.setLineWidth(0.5);
  doc.setDrawColor(0);

  // ---- Título en caja ----
  const tituloTxt = (titulo.trim() || "RELACION GASTOS NO DEDUCIBLES").toUpperCase();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  const lineasTitulo: string[] = doc.splitTextToSize(tituloTxt, PAG_W - MARGEN * 2 - 10);
  const tituloH = lineasTitulo.length * 11 + 6;
  doc.rect(MARGEN, MARGEN, PAG_W - MARGEN * 2, tituloH);
  lineasTitulo.forEach((l, i) => {
    doc.text(l, PAG_W / 2, MARGEN + 10 + i * 11, { align: "center" });
  });
  const TOPE_PRIMERA = MARGEN + tituloH + 14;
  const TOPE_RESTO = MARGEN;
  const FONDO = PAG_H - MARGEN;

  // ---- Agrupar por TC ----
  const porTC = new Map<string, GastoPDF[]>();
  for (const g of gastos) {
    const arr = porTC.get(g.tc) ?? [];
    arr.push(g);
    porTC.set(g.tc, arr);
  }
  const tcs = [...porTC.keys()].sort((a, b) => a.localeCompare(b));

  // ---- Cursor de flujo (columna, página, y) ----
  let col = 0;
  let pagina = 1;
  let y = TOPE_PRIMERA;
  const tope = () => (pagina === 1 ? TOPE_PRIMERA : TOPE_RESTO);
  const colX = () => MARGEN + col * (COL_W + GAP);

  function avanzar() {
    if (col === 0) {
      col = 1;
    } else {
      col = 0;
      pagina += 1;
      doc.addPage();
    }
    y = tope();
  }

  const sinTC = (tc: string) => tc.replace(/^\s*tc\s*/i, "").trim();

  function etiquetaTC(tc: string, continuacion: boolean) {
    const x = colX();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FUENTE + 0.5);
    const base = `TC${sinTC(tc)}`;
    const txt = continuacion ? `${base} (cont.)` : base;
    const w = Math.max(56, doc.getTextWidth(txt) + 10);
    doc.setFillColor(...VERDE);
    doc.rect(x, y, w, TAG_H, "FD");
    doc.text(txt, x + 3, y + 8.5);
    const resp = responsables[sinTC(tc)];
    if (resp) {
      doc.setFontSize(FUENTE);
      const disp = COL_W - w - 8;
      let r = resp;
      while (r.length > 1 && doc.getTextWidth(r) > disp) r = r.slice(0, -1);
      doc.text(r === resp ? r : `${r.trimEnd()}…`, x + w + 6, y + 8.5);
    }
    y += TAG_H;
  }

  let saldoTotal = 0;

  for (const tc of tcs) {
    const filas = [...(porTC.get(tc) ?? [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
    const subtotal = filas.reduce((s, g) => s + Number(g.valor), 0);
    saldoTotal += subtotal;

    // Altura total del bloque (etiqueta + filas + total) para no partirlo si cabe entero
    doc.setFont("helvetica", "normal");
    doc.setFontSize(FUENTE);
    const alturaBloque =
      TAG_H +
      filas.reduce((s, g) => {
        const n: string[] = doc.splitTextToSize(g.descripcion || "", DESC_W);
        return s + Math.max(1, n.length) * LINEA + 3;
      }, 0) +
      TOTAL_H;
    const columnaCompleta = FONDO - (pagina === 1 ? TOPE_PRIMERA : TOPE_RESTO);
    if (alturaBloque <= columnaCompleta && y + alturaBloque > FONDO) avanzar();
    else if (y + TAG_H + LINEA + 4 > FONDO) avanzar();
    etiquetaTC(tc, false);

    for (const g of filas) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(FUENTE);
      const desc: string[] = doc.splitTextToSize(g.descripcion || "", DESC_W);
      const alto = Math.max(1, desc.length) * LINEA + 3;
      if (y + alto > FONDO) {
        avanzar();
        etiquetaTC(tc, true);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FUENTE);
      }
      const x = colX();
      doc.rect(x, y, COL_W, alto);
      doc.text(formatFecha(g.fecha), x + PAD, y + LINEA - 0.5 + 1);
      desc.forEach((l, i) => doc.text(l, x + PAD + FECHA_W, y + LINEA - 0.5 + 1 + i * LINEA));
      doc.text(miles(Number(g.valor)), x + COL_W - PAD, y + LINEA - 0.5 + 1, { align: "right" });
      y += alto;
    }

    if (y + TOTAL_H > FONDO) {
      avanzar();
      etiquetaTC(tc, true);
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FUENTE + 0.5);
    const x = colX();
    doc.text("TOTAL:", x + PAD, y + 11);
    doc.text(`$ ${miles(subtotal)}`, x + COL_W - PAD, y + 11, { align: "right" });
    y += TOTAL_H + 8;
  }

  // ---- SALDO TOTAL ----
  if (y + TOTAL_H > FONDO) avanzar();
  const xs = colX();
  doc.setFillColor(...VERDE);
  doc.rect(xs, y, COL_W, TOTAL_H, "FD");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(FUENTE + 0.5);
  doc.text("SALDO TOTAL", xs + PAD, y + 11);
  doc.text(`$ ${miles(saldoTotal)}`, xs + COL_W - PAD, y + 11, { align: "right" });

  const nombre =
    tituloTxt
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 80) || "gastos_no_deducibles";

  return { doc, nombre, saldoTotal };
}
