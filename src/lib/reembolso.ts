/**
 * Formato de reembolso de gastos (SPL = Steelforce Packaging Latam, SPI = Steelforce Packaging
 * Industrial). Se abre la plantilla original (.xlsx) y SOLO se escriben, desde la fila 15,
 * Fecha (B), Proveedor (C, aquí va la descripción) y Valor Unitario (H). Las fórmulas, el
 * logo y el resto de columnas no se tocan.
 */
import type JSZipType from "jszip";

export type Empresa = "SPL" | "SPI";

export type GastoReembolso = { fecha: string; descripcion: string; valor: number };

const PRIMERA_FILA = 15;
/** Última fila de gastos de cada formato (la siguiente es la del TOTAL) */
const ULTIMA_FILA: Record<Empresa, number> = { SPL: 135, SPI: 139 };
const HOJA = "xl/worksheets/sheet1.xml";

export const NOMBRE_EMPRESA: Record<Empresa, string> = {
  SPL: "Steelforce Packaging Latam (SPL)",
  SPI: "Steelforce Packaging Industrial (SPI)",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fecha ISO -> número de serie de Excel (solo fecha) */
function serial(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
}

/** Pone valor en una celda ya existente (con su estilo) de una fila. */
function ponerCelda(filaXml: string, ref: string, contenido: { num?: number; txt?: string }): string {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const m = filaXml.match(re);
  if (!m) return filaXml; // la celda no existe en la plantilla: no se inventa
  const attrs = (m[1] ?? "").replace(/\s+t="[^"]*"/, "");
  const nueva =
    contenido.txt !== undefined
      ? `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(contenido.txt)}</t></is></c>`
      : `<c r="${ref}"${attrs}><v>${contenido.num}</v></c>`;
  return filaXml.replace(re, nueva);
}

export function capacidad(empresa: Empresa): number {
  return ULTIMA_FILA[empresa] - PRIMERA_FILA + 1;
}

export async function generarReembolso(empresa: Empresa, gastos: GastoReembolso[]): Promise<Blob> {
  if (gastos.length > capacidad(empresa)) {
    throw new Error(
      `El formato ${empresa} solo tiene espacio para ${capacidad(empresa)} gastos y hay ${gastos.length}.`,
    );
  }
  const JSZip = (await import("jszip")).default as typeof JSZipType;
  const resp = await fetch(`/plantillas/reembolso_${empresa.toLowerCase()}.xlsx`);
  if (!resp.ok) throw new Error("No pude cargar la plantilla del formato.");
  const zip = await JSZip.loadAsync(await resp.arrayBuffer());

  let hoja = await zip.file(HOJA)!.async("string");
  gastos.forEach((g, i) => {
    const n = PRIMERA_FILA + i;
    hoja = hoja.replace(new RegExp(`<row r="${n}"[\\s\\S]*?</row>`), (fila) => {
      // La plantilla trae las filas de abajo ocultas: se muestran las que se usan
      let f = fila.replace(/^(<row [^>]*?)\s+hidden="1"/, "$1");
      f = ponerCelda(f, `B${n}`, { num: serial(g.fecha) });
      f = ponerCelda(f, `C${n}`, { txt: g.descripcion });
      f = ponerCelda(f, `H${n}`, { num: Math.round(g.valor * 100) / 100 });
      return f;
    });
  });
  zip.file(HOJA, hoja);

  // Que Excel recalcule los totales al abrir (las fórmulas quedan intactas)
  const wbPath = "xl/workbook.xml";
  const wb = await zip.file(wbPath)!.async("string");
  zip.file(wbPath, wb.replace(/<calcPr([^>]*?)\/>/, (_m, a: string) =>
    /fullCalcOnLoad/.test(a) ? `<calcPr${a}/>` : `<calcPr${a} fullCalcOnLoad="1"/>`,
  ));

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    compression: "DEFLATE",
  });
}
