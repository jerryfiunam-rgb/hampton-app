// Lectura de PDF: agrupa los fragmentos de texto de PDF.js en líneas por posición
// y detecta período, saldos y filas con patrón de fecha + importes.
// No ejecuta nada del PDF: solo usa getTextContent().

export const PDF_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_MAX_PAGES = 100;
export const MAX_FILES = 12;

const MONTHS = { ENE: 1, ENERO: 1, FEB: 2, FEBRERO: 2, MAR: 3, MARZO: 3, ABR: 4, ABRIL: 4, MAY: 5, MAYO: 5, JUN: 6, JUNIO: 6, JUL: 7, JULIO: 7, AGO: 8, AGOSTO: 8, SEP: 9, SEPT: 9, SEPTIEMBRE: 9, SETIEMBRE: 9, OCT: 10, OCTUBRE: 10, NOV: 11, NOVIEMBRE: 11, DIC: 12, DICIEMBRE: 12 };

// items: [{str, transform:[a,b,c,d,x,y]}] de PDF.js. Devuelve texto con líneas ordenadas.
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
    const x = it.transform?.[4] ?? 0, y = it.transform?.[5] ?? 0;
    let row = rows.find(r => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join('  ').replace(/\s{3,}/g, '   ').trim());
}

export function checkFileLimits(file) {
  if (!file) return 'Archivo vacío.';
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return `«${file.name}» no es un PDF.`;
  if (file.size > PDF_MAX_BYTES) return `«${file.name}» pesa ${(file.size / 1048576).toFixed(1)} MB; el límite es 20 MB. Divide el archivo o exporta solo el mes.`;
  return null;
}

const strip = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Detecta el período (YYYY-MM) a partir del texto: "PERIODO DEL 01/ENE/2026 AL 31/ENE/2026", "ENERO 2026", "01/01/2026 AL 31/01/2026".
export function detectPeriod(text) {
  const t = strip(text).slice(0, 6000);
  let m = t.match(/AL\s+\d{1,2}[\/\-\s]+([A-Z]{3,10})[\/\-\s]+(20\d{2})/);
  if (m && MONTHS[m[1]]) return `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}`;
  m = t.match(/AL\s+\d{1,2}[\/\-](\d{1,2})[\/\-](20\d{2})/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  m = t.match(/\b(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|SETIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\b[\sDE]*(20\d{2})/);
  if (m) return `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}`;
  return null;
}

const AMT = /-?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}|-?\$?\s?\d+\.\d{2}/g;
const toNum = s => Number(String(s).replace(/[$,\s]/g, ''));

// Busca saldos del resumen por etiquetas habituales en bancos mexicanos.
export function detectSummary(text) {
  const lines = strip(text).split('\n');
  const find = (re) => {
    for (const l of lines) if (re.test(l)) { const a = l.match(AMT); if (a) return toNum(a.at(-1)); }
    return null;
  };
  return {
    initialBalance: find(/SALDO\s+(INICIAL|ANTERIOR)/),
    finalBalance: find(/SALDO\s+(FINAL|ACTUAL|AL CORTE)/),
    reportedIncome: find(/(TOTAL\s+)?(DEPOSITOS|ABONOS)/),
    reportedExpense: find(/(TOTAL\s+)?(RETIROS|CARGOS)/),
  };
}

// Heurística: filas que empiezan con fecha y contienen importes.
export function detectMovementRows(pages) {
  const rows = [];
  const dateRe = /^(\d{1,2}[\/\-\s](?:\d{1,2}|[A-Za-z]{3})(?:[\/\-\s]\d{2,4})?)\s+(.*)$/;
  for (const p of pages) for (const line of p.text.split('\n')) {
    const m = line.match(dateRe);
    if (!m) continue;
    const amts = line.match(AMT);
    if (!amts) continue;
    rows.push({ page: p.number, line });
  }
  return rows;
}
