// Recorrido completo en Chromium con PROVEEDOR SIMULADO de Claude (no es validación de IA real).
// Uso: node tests/e2e.mjs <ruta a pdfjs-dist/build> <carpeta de capturas>
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PDFJS = process.argv[2];
const SHOTS = process.argv[3] || '/tmp';

// Simulación de window.claude (inyectada solo en esta prueba).
const MOCK = () => {
  const between = (s, t) => { const a = s.indexOf(`<${t}>`), b = s.indexOf(`</${t}>`); return a < 0 ? '' : s.slice(a + t.length + 2, b).trim(); };
  const MES = { ENE: '01', FEB: '02', MAR: '03' };
  window.__calls = []; window.__saved = [];
  async function sample(prompt, opts = {}) {
    window.__active = (window.__active || 0) + 1;
    window.__maxActive = Math.max(window.__maxActive || 0, window.__active);
    try { return await sampleInner(prompt, opts); } finally { window.__active--; }
  }
  async function sampleInner(prompt, opts = {}) {
    await new Promise(r => setTimeout(r, /OPERACIÓN: interpret/.test(prompt) ? 600 : 150));
    const op = (prompt.match(/OPERACIÓN: (\w+)/) || [])[1];
    window.__calls.push(op + (opts.images ? `+${opts.images.length}img` : ''));
    let out;
    // Simula el límite de salida: el PDF mixto completo (2 páginas) produce una respuesta truncada.
    if (op === 'interpret' && /ESCANEADA/.test(prompt) && prompt.includes('--- Página 1 ---')) {
      window.__truncations = (window.__truncations || 0) + 1;
      return { text: '{"period":"2026-03","movements":[', truncated: true };
    }
    if (op === 'origins') {
      // Simula la segunda lectura: dos pagos de departamentos distintos y un renglón repetido.
      window.__originsCalls = (window.__originsCalls || 0) + 1;
      return { text: JSON.stringify({ origins: [{ i: 0, origin: 'Torre 1 - 101', concept: 'Torre 1 - 101 Cuota ordinaria marzo 2026' }, { i: 1, origin: 'Torre 2 - 202', concept: 'Torre 2 - 202 Cuota ordinaria marzo 2026' }, { i: 2, origin: '', duplicate: true }] }), truncated: false };
    }
    if (op === 'interpret' && /ESCANEADA/.test(prompt)) {
      // Simulación: la "lectura" de la imagen devuelve los movimientos del PDF sintético mixto.
      if (!opts.images?.length || !(opts.images[0] instanceof Blob)) throw { code: 'invalid_request', message: 'sin imagen' };
      window.__imageBytes = opts.images[0].size;
      const mv = (d, c, a, t) => ({ date: `2026-03-${d}`, concept: c, amount: a, type: t, category: '', sourcePageNumber: 2, sourceText: c });
      out = { period: '2026-03', bank: 'Banco de prueba', initialBalance: 533500, finalBalance: 561400, reportedIncome: 115000, reportedExpense: 87100, movements: [mv('05', 'CUOTA MANTENIMIENTO DEPTO 101-140', 115000, 'abono'), mv('08', 'SERV LIMPIEZA MARZO', 18000, 'cargo'), mv('10', 'VIGILANCIA SEGURIDAD PRIVADA', 48000, 'cargo'), mv('12', 'CFE LUZ AREAS COMUNES', 6100, 'cargo'), mv('15', 'HONORARIOS ADMINISTRACION', 15000, 'cargo'), mv('20', 'Cuota ordinaria marzo 2026', 2500, 'abono'), mv('20', 'Cuota ordinaria marzo 2026', 2500, 'abono'), mv('20', 'Cuota ordinaria marzo 2026', 2500, 'abono')], questions: [], notes: [] };
    } else if (op === 'interpret') {
      const t = between(prompt, 'estado_de_cuenta');
      const per = t.match(/AL \d+\/([A-Z]{3})\/(\d{4})/);
      const period = `${per[2]}-${MES[per[1]]}`;
      const val = re => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
      const movements = [];
      for (const line of t.split('\n')) {
        const m = line.match(/^(\d{2})\/([A-Z]{3})\s+(.+?)\s+([\d,]+\.\d{2})$/);
        if (!m) continue;
        const abono = /CUOTA|APORTACION/.test(m[3]);
        movements.push({ date: `${period}-${m[1]}`, concept: m[3].trim(), amount: Number(m[4].replace(/,/g, '')), type: abono ? 'abono' : 'cargo', category: '', sourcePageNumber: 1, sourceText: line });
      }
      if (period === '2026-02') movements.push({ date: '2024-01-02', concept: 'Torre 3 - 402 Cuota de fondo de reserva 2024', amount: 1200, type: 'abono', category: '', sourcePageNumber: 1 });
      out = { period, bank: 'Banco de prueba', accountType: 'Cheques', currency: 'MXN', initialBalance: val(/SALDO ANTERIOR\s+([\d,.]+)/), finalBalance: val(/SALDO FINAL\s+([\d,.]+)/), reportedIncome: val(/DEPOSITOS\s+([\d,.]+)/), reportedExpense: val(/RETIROS\s+([\d,.]+)/), movements, delinquency: period === '2026-03' ? { found: false, rows: [] } : period === '2026-01' ? { found: true, asOf: '2026-01-31', reportedTotal: 5070, rows: [{ unit: 'Torre 1 - 101', amount: 5000, months: 2, sourcePageNumber: 1 }, { unit: 'Torre 4 - 303', amount: 70, months: 1, sourcePageNumber: 1 }] } : { found: true, asOf: '2026-02-28', reportedTotal: 10000, rows: [{ unit: 'Torre 1 - 101', amount: 7500, months: 3, sourcePageNumber: 1 }, { unit: 'Torre 2 - 202', amount: 2500, months: 1, sourcePageNumber: 1 }] }, questions: [{ prompt: '¿El estado incluye otra cuenta de inversión del condominio?', blocking: false }, ...(period === '2026-01' ? [{ prompt: 'El cargo de $6,200.00 del 12/01/2026 por luz no indica el medidor. ¿Corresponde a áreas comunes?', blocking: false }] : [])], notes: period === '2026-02' ? [
        'Aritmética bancaria cuadra: 648,404.56 + 212,901.83 − 187,641.84 = 673,664.55 (coincide con el saldo actual del estado de cuenta).',
        'Los movimientos fueron tomados de los reportes de ingresos y egresos (páginas 4 a 8). La página 1 solo muestra el resumen.',
        'El depósito en efectivo de $3,500.00 va a Caja Chica y no forma parte de los abonos bancarios; se incluyó con cash=true.',
        'La Torre 4 - 303 pagó $2,430.00 y tiene $70.00 pendientes de aplicar el mismo día, lo que sugiere (hipótesis) un pago de $2,500.00 dividido.',
        { kind: 'inconsistencia', title: 'Subtotal con etiqueta equivocada', detail: "En el reporte de egresos, el subtotal de 'Reembolsos de Caja Chica' ($5,000.00) está rotulado 'Total 6. Honorarios contables'." },
        'La numeración de cuotas de mantenimiento repite el número 58 (dos renglones); en total hay 75 renglones listados.' ] : [] };
    } else if (op === 'analyze') {
      const c = JSON.parse(between(prompt, 'candidatos_motor'));
      out = { executiveSummary: 'Resumen simulado: el período cierra con saldo de $561,400.00 y presenta dos descuadres que deben aclararse antes de la Asamblea.', facts: [{ text: 'El saldo final de 2026-01 es $566,000.00 y el saldo inicial de 2026-02 es $564,000.00.', source: 'pdf' }, { text: 'El motor calcula un descuadre de $1,000.00 en 2026-02.', source: 'motor' }], interpretation: ['La discontinuidad sugiere que falta registrar un movimiento entre ambos cortes, lo que impide afirmar que los saldos reflejan la realidad de la cuenta.', 'El gasto de jardinería de febrero duplica el de enero.'], hypotheses: [{ text: 'Podría tratarse de una comisión bancaria no reflejada en el estado.', quantified: false }], comparabilityNote: '', findings: c.slice(0, 5).map((a, i) => ({ id: `H${i + 1}`, title: a.title, facts: [a.detail], interpretation: 'Interpretación simulada del hallazgo.', description: a.detail, evidence: a.evidence, category: 'NO_CLASIFICADO', level: a.level, kind: a.kind, impact: 'Impacto simulado', recommendation: 'Recomendación simulada', missingData: '', hypotheses: [{ text: 'Hipótesis simulada cuantificada', quantified: true }], sourceRule: a.id })) };
    } else if (op === 'report') {
      const f = JSON.parse(between(prompt, 'hallazgos_confirmados'));
      out = { executiveSummary: 'Resumen ejecutivo simulado con extensión suficiente para pasar la validación del reporte.', flowAnalysis: 'Flujo simulado.', expenseAnalysis: 'Egresos simulados.', fundsAnalysis: 'Fondos simulados.', delinquencyAnalysis: 'Sin datos de morosidad.', findings: f.map(x => ({ id: x.id, title: x.title, level: x.level, narrative: 'Narrativa simulada.', evidenceSummary: 'Evidencia simulada.', recommendation: 'Recomendación simulada.', missingData: '' })), limitations: 'Limitaciones simuladas.' };
    } else if (op === 'alert') {
      window.__alertPrompt = prompt;
      const f = JSON.parse(between(prompt, 'hallazgos_confirmados'));
      out = { addressee: 'Comité de Vigilancia', sender: 'Análisis IA', reference: 'Prueba', date: 'hoy', body: Array(420).fill('texto').join(' '), findings: f.map(x => ({ id: x.id, title: x.title, level: x.level, risk: 'riesgo', requiredAction: 'acción', suggestedDeadline: '15 días' })), questionsForCommittee: ['¿P1?', '¿P2?', '¿P3?'], legalWarning: 'Los hallazgos Críticos no atendidos deben escalarse a la Asamblea conforme al artículo 39 de la LPCIDF.' };
    } else out = 'OK';
    return { text: typeof out === 'string' ? out : JSON.stringify(out), truncated: false };
  }
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 10e6, mediaTypes: ['image/jpeg', 'image/png'] } });
  window.claude = { use: async n => n === 'sample' ? sample : n === 'downloads' ? { save: async r => { window.__saved.push({ filename: r.filename, size: String(r.data).length, data: String(r.data) }); return { status: 'saved' }; } } : null };
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_FAILED|net::/.test(m.text())) errs.push(m.text()); });
await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ path: path.join(PDFJS, path.basename(new URL(r.request().url()).pathname)), contentType: 'text/javascript' }));
await page.route('https://fonts.googleapis.com/**', r => r.abort());
await page.addInitScript(MOCK);
await page.goto('file://' + path.join(ROOT, 'dist/index.html'));
const ok = (c, m) => { if (!c) throw new Error('FALLÓ: ' + m); console.log('✓', m); };

ok((await page.textContent('header')).includes('Análisis de estados de cuenta - Condominio Hampton Court') && !(await page.$('#c-name')), 'Encabezado fijo del condominio, sin captura de datos');
await page.setInputFiles('#pdf-in', [path.join(ROOT, 'tests/fixtures/sintetico-2026-01.pdf'), path.join(ROOT, 'tests/fixtures/sintetico-2026-02.pdf'), path.join(ROOT, 'tests/fixtures/sintetico-2026-03-mixto.pdf')]);
await page.waitForFunction(() => document.querySelectorAll('.files li').length === 3 && !document.querySelector('.files .spinner'), null, { timeout: 60000 });
const filesTxt = await page.textContent('.files');
ok(filesTxt.includes('2026-01'), 'PDF.js extrae texto y detecta período');
ok(!(await page.$('[data-act="connect"]')) && (await page.textContent('main')).includes('Claude disponible vía claude.ai') && !!(await page.$('#consent')), 'Sin botón de prueba de conexión; indicador y autorización presentes');
const connSec = await page.$('text=Claude y autorización >> xpath=ancestor::section[1]');
await connSec.screenshot({ path: `${SHOTS}/autorizacion.png` });
ok(/2 pág\. \(1 escaneada\)/.test(filesTxt) && filesTxt.includes('2026-03'), 'PDF mixto: página de texto leída y página escaneada detectada');
await page.check('#consent');
await (await page.$('.roles')).screenshot({ path: `${SHOTS}/roles.png` });
await page.screenshot({ path: `${SHOTS}/1-carga.png` });
await page.screenshot({ path: `${SHOTS}/1-carga-full.png`, fullPage: true });
await page.click('[data-act="interpret"]');
await page.waitForSelector('.pfiles li'); await page.waitForTimeout(250); await (await page.$('#busy-interpret')).screenshot({ path: `${SHOTS}/progreso.png` });
await page.waitForSelector('text=Confirmar datos >> nth=0');
await page.waitForFunction(() => document.querySelector('.stage-head .k')?.textContent.includes('Etapa 2'));
ok(true, 'Interpretación de 3 meses y paso a confirmar datos');
const maxActive = await page.evaluate(() => window.__maxActive);
ok(maxActive >= 2 && maxActive <= 3, `Lecturas en paralelo, máximo 3 a la vez (máximo observado: ${maxActive})`);
const layout = await page.evaluate(() => ({ docScroll: document.scrollingElement.scrollHeight - innerHeight, mainOverflow: getComputedStyle(document.querySelector('main')).overflowY, mainScrolls: document.querySelector('main').scrollHeight > document.querySelector('main').clientHeight }));
ok(layout.docScroll <= 1 && layout.mainOverflow === 'auto' && layout.mainScrolls, 'Encabezado y menú fijos: solo se desplaza el área central');
await page.evaluate(() => { document.querySelector('main').scrollTop = 400; });
const hdrTop = await page.evaluate(() => document.querySelector('header').getBoundingClientRect().top);
ok(hdrTop >= 0 && hdrTop < 2, 'El encabezado sigue visible al desplazar');
ok((await page.evaluate(() => window.__calls)).includes('interpret+1img') && (await page.evaluate(() => window.__imageBytes)) > 20000, 'La página escaneada se envía a Claude como imagen JPEG');
ok((await page.evaluate(() => window.__truncations)) === 1 && (await page.textContent('details.log')).includes('se divide en dos lotes'), 'Respuesta truncada: el PDF se divide en lotes de páginas automáticamente');
ok((await page.textContent('main')).includes('$561,400.00'), 'Los lotes se unen con los saldos del resumen');
ok((await page.$$('.pill.scan')).length === 7, 'Movimientos leídos de la imagen marcados como «Escaneado»');
const origins = await page.$$eval('input[data-origin]', els => els.map(e => e.value));
ok((await page.evaluate(() => window.__originsCalls)) === 1 && origins.includes('Torre 1 - 101') && origins.includes('Torre 2 - 202'), 'Segunda lectura identifica el departamento de abonos idénticos');
const mainTxt = await page.textContent('main');
ok(mainTxt.includes('Torre 1 - 101 Cuota ordinaria marzo 2026') && mainTxt.includes('Renglones repetidos eliminados'), 'Concepto completo recuperado y renglón repetido eliminado');
ok(!mainTxt.includes('abonos iguales «Cuota ordinaria marzo 2026»'), 'Sin aviso pendiente cuando todos quedan identificados');
const body2 = await page.textContent('main');
ok(body2.includes('Diferencia') && body2.includes('Discontinuidad'), 'Se señalan descuadre y discontinuidad');
ok(body2.includes('Bloqueante'), 'Pregunta bloqueante por egreso sin categoría > $5,000');
const qLuz = await page.$('.q:has-text("El cargo de $6,200.00 del 12/01/2026")');
const luzLink = qLuz ? await qLuz.$('[data-scroll^="mv-"]') : null;
ok(!!luzLink && (await luzLink.getAttribute('data-scroll')) === 'mv-2026-01-004', 'Pregunta de Claude ligada a su movimiento por monto y fecha');
await luzLink.click();
await page.waitForTimeout(1200);
const flashed = await page.$eval('#mv-2026-01-004', el => ({ flash: el.classList.contains('flash'), open: el.closest('details').open, visible: (() => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })() }));
ok(flashed.flash && flashed.open && flashed.visible, 'El enlace abre el mes, lleva al movimiento y lo resalta');
ok(body2.includes('Reporte de morosidad por departamento') && body2.includes('Torre 2 - 202') && body2.includes('2 de 80 departamentos con adeudo'), 'Morosidad por departamento visible en la confirmación');
ok(body2.includes('no encontró un reporte de morosidad'), 'Mes sin reporte de morosidad señalado');
ok(!!(await page.$('#abandon [data-act="new"]')), 'Opción de interrumpir el análisis en la etapa 2');
const fundRow = await page.$('tr.fund-op');
const fundRowTxt = fundRow ? await fundRow.textContent() : '';
ok(fundRowTxt.includes('Fondo de Administración y Mantenimiento') && fundRowTxt.includes('Operativo') && /\$[\d,]+\.\d{2}/.test(fundRowTxt), 'Fondos identificados incluye el Fondo de Administración y Mantenimiento');
await (await page.$('text=Fondos identificados >> xpath=ancestor::section[1]')).screenshot({ path: `${SHOTS}/fondos.png` });
const fundOf = async concept => page.$eval(`xpath=//tr[td[3][starts-with(normalize-space(.), "${concept}")]]//select[@data-mvfund]`, el => el.value);
ok(await fundOf('CUOTA MANTENIMIENTO DEPTO 101-140') === 'Fondo de Administración y Mantenimiento', 'Cuota ordinaria asignada al Fondo de Administración');
ok(await fundOf('APORTACION IMPERMEAB EDIF 1') === 'Fondo de Impermeabilización', 'Aportación de impermeabilización en su fondo');
ok(await fundOf('SERV LIMPIEZA ENERO') === 'Fondo de Administración y Mantenimiento' && await fundOf('HONORARIOS ADMINISTRACION') === 'Fondo de Administración y Mantenimiento', 'Gastos corrientes asignados al Fondo de Administración y Mantenimiento');
ok(await fundOf('SPEI 4471 PROV XYZ') === 'No especificado', 'Sin certeza: «No especificado»');
ok((await page.$$('td .pill.abono')).length > 0 && (await page.$$('td .pill.cargo')).length > 0, 'Tipo en color: abono verde y cargo rojo');
const orgIn = await page.$('xpath=//tr[td[3][starts-with(normalize-space(.), "APORTACION IMPERMEAB EDIF 1")]]//input[@data-origin]');
ok(!!orgIn && !(await page.$('xpath=//tr[td[3][starts-with(normalize-space(.), "SERV LIMPIEZA ENERO")]]//input[@data-origin]')), 'Origen editable en abonos y no en cargos ordinarios');
await orgIn.evaluate(el => { el.closest('details').open = true; });
await orgIn.fill('Torre 1 - 105'); await orgIn.press('Tab');
await page.waitForTimeout(150);
ok((await page.textContent('main')).includes('origen no identificado → Torre 1 - 105') || (await page.textContent('main')).includes('→ Torre 1 - 105'), 'Corrección de origen registrada');
const tbl = await page.$('xpath=//tr[td[3][starts-with(normalize-space(.), "CUOTA MANTENIMIENTO DEPTO 101-140")]]/ancestor::table[1]');
await tbl.evaluate(el => { el.closest('details').open = true; });
await tbl.scrollIntoViewIfNeeded(); await tbl.screenshot({ path: `${SHOTS}/movimientos.png` });
const numbering = await page.$$eval('details.month', ds => ds.map(d => ({ nums: [...d.querySelectorAll('td.rownum')].map(td => Number(td.textContent)), count: Number((d.querySelector('summary').textContent.match(/(\d+) mov\./) || [])[1]) })));
ok(numbering.length === 3 && numbering.every(x => x.nums.length === x.count && x.nums.every((n, i) => n === i + 1)), 'Columna No. numera del 1 al total de movimientos de cada mes');
await page.click('[data-act="check-all"]');
ok((await Promise.all(['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity', 'delinquency'].map(k => page.isChecked(`#chk-${k}`)))).every(Boolean), 'Seleccionar todo marca las ocho casillas');
await page.click('[data-act="check-none"]');
ok(!(await Promise.all(['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity', 'delinquency'].map(k => page.isChecked(`#chk-${k}`)))).some(Boolean), 'Deseleccionar todo desmarca las casillas');
await page.click('[data-act="check-all"]');
ok(await page.isDisabled('[data-act="confirm"]'), 'La casilla general no permite avanzar con pregunta bloqueante');
await page.screenshot({ path: `${SHOTS}/2-confirmar.png`, fullPage: false });
const notesEl = await page.$('details.notes');
ok(!!notesEl && (await page.$$('details.notes .ng li')).length === 7, 'Observaciones de Claude separadas y agrupadas');
await notesEl.scrollIntoViewIfNeeded(); await notesEl.screenshot({ path: `${SHOTS}/notas.png` });
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('hampton-analisis-v1')).role) === 'condomino', 'Rol por defecto: Condómino');
const speiQ = await page.$('.q.blocking:has-text("SPEI 4471 PROV XYZ")');
const draftTxt = await (await speiQ.$('textarea[id^="obs-"]')).inputValue();
ok(/^Se solicita a la administración aclarar el concepto y destino del cargo «SPEI 4471 PROV XYZ»/.test(draftTxt) && !(await speiQ.$('select[data-qcat]')), 'Condómino: observación sugerida en lugar de respuesta');
await speiQ.scrollIntoViewIfNeeded(); await speiQ.screenshot({ path: `${SHOTS}/aclaracion.png` });
await (await speiQ.$('[data-act="q-answer"]')).click();
ok(!!(await page.$('.q.blocking:has-text("SPEI 4471 PROV XYZ") select[data-qcat]')), '«Tengo la respuesta» muestra el campo para responder');
await (await page.$('.q.blocking:has-text("SPEI 4471 PROV XYZ") textarea[id^="obs-"]')).fill('Se solicita el comprobante del pago SPEI 4471 de $7,500.00 del 22/02/2026.');
await page.click('.q.blocking:has-text("SPEI 4471 PROV XYZ") [data-act="q-obs"]');
await page.waitForTimeout(200);
const obsPanel = await page.textContent('#observations');
ok(!(await page.$('.q.blocking:has-text("SPEI 4471 PROV XYZ")')) && obsPanel.includes('Observaciones para la administración (1)') && obsPanel.includes('comprobante del pago SPEI 4471') && (await page.$$('td .pill.moderate:text("Sin aclarar")')).length === 1, 'Enviar como observación resuelve la duda bloqueante y la lista');
for (const k of ['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity', 'delinquency']) if (!(await page.isChecked(`#chk-${k}`))) await page.check(`#chk-${k}`);
const oopTxt = await page.textContent('#q-q-oop-2026-02');
ok(/1 movimiento\(s\) tienen fecha fuera del período/.test(oopTxt) && oopTxt.includes('2024-01-02') && /excluyéndolos: diferencia \$1,000\.00/.test(oopTxt) && (await page.$$('td .pill.bad:text("Fuera del período")')).length === 1, 'Movimiento de 2024 detectado fuera del período, con el cuadre de cada opción');
ok(await page.isDisabled('[data-act="confirm"]'), 'Fuera del período bloquea la confirmación hasta decidir');
await page.click('[data-act="oop-exclude"][data-period="2026-02"]');
await page.waitForTimeout(150);
ok(!(await page.$('#q-q-oop-2026-02')) && (await page.textContent('main')).includes('1 excluidos') && (await page.textContent('main')).includes('Excluidos 1 movimiento(s) con fecha fuera del período'), 'Excluir quita el movimiento y lo documenta');
if (!(await page.isDisabled('[data-act="check-all"]'))) await page.click('[data-act="check-all"]');
// pregunta informativa de texto sin responder: no bloquea
ok(!(await page.isDisabled('[data-act="confirm"]')), 'Al responder la pregunta se habilita confirmar');
await page.click('[data-act="confirm"]');
await page.click('[data-go="3"]:not(.step)');
await page.click('[data-act="analyze"]');
await page.waitForSelector('text=Hallazgos propuestos');
const d = await page.textContent('main');
ok(/Descuadre aritmético en 2026-02/.test(d) && d.includes('$1,000.00'), 'Regla de cuadre: crítico por $1,000');
ok(/Cobertura del saldo libre\s*[\d.,]+ meses/.test(d) && d.includes('No es el número de meses analizados') && d.includes('sin saldo previo capturado'), 'Cobertura del saldo libre explicada con sus cifras y aviso de saldo previo');
await (await page.$('.kpis')).screenshot({ path: `${SHOTS}/kpis.png` });
ok(/Discontinuidad de saldo 2026-01 → 2026-02/.test(d) && d.includes('$2,000.00'), 'Regla de continuidad: crítico por $2,000');
ok(/Pago duplicado probable/.test(d), 'Regla de duplicado probable (jardinería)');
ok(/Sin pago de honorarios/.test(d), 'Regla de honorarios ausentes');
ok(d.includes('Morosidad por departamento') && /1 departamento\(s\) con 3 o más meses de adeudo/.test(d) && /La morosidad aumentó/.test(d), 'Diagnóstico con morosidad por departamento y reglas de morosidad');
await (await page.$('text=Morosidad por departamento >> xpath=ancestor::section[1]')).screenshot({ path: `${SHOTS}/morosidad.png` });
await page.screenshot({ path: `${SHOTS}/3-diagnostico.png`, fullPage: true });
ok((await page.$$('.plane.fact li')).length === 2 && (await page.$$('.plane.interp li')).length === 2 && (await page.$$('.plane.hyp li')).length === 1, 'Diagnóstico separado en hechos, interpretación e hipótesis');
ok((await page.$$('.finding .frow.fact')).length === 5 && (await page.$$('.finding .frow.interp')).length === 5, 'Cada hallazgo separa hechos e interpretación');
ok(await page.$eval('.plane.interp li span', el => getComputedStyle(el).textAlign) === 'justify', 'Texto justificado');
await (await page.$('.planes')).screenshot({ path: `${SHOTS}/planos.png` });
await (await page.$('.finding')).screenshot({ path: `${SHOTS}/hallazgo.png` });
await page.click('text=Continuar a hallazgos');
ok((await page.$$('.finding.sel')).length === 0, 'Selección no precargada');
await page.click('[data-act="sel-all"]');
ok((await page.$$('.order li')).length === 5, 'Seleccionar todos agrega los cinco hallazgos');
await page.click('[data-act="sel-none"]');
ok((await page.$$('.order li')).length === 0 && await page.isDisabled('[data-act="confirm-sel"]'), 'Sin selección no se puede confirmar');
for (const id of ['H2', 'H1', 'H3', 'H4']) await page.click(`[data-act="toggle-sel"][data-id="${id}"]`);
ok((await page.$$('.order li')).length === 4, 'Se pueden elegir más de tres hallazgos');
await page.click('.order [data-act="toggle-sel"][data-id="H4"]');
ok((await page.$$('.order li')).length === 3 && !(await page.$('.order [data-id="H4"]')), 'Quitar un hallazgo específico desde «Tu selección»');
await page.click('[data-act="toggle-sel"][data-id="H4"]');
ok((await page.$$('.order li')).length === 4, 'Se puede volver a agregar');
await (await page.$('.order')).screenshot({ path: `${SHOTS}/seleccion.png` });
await page.click('[data-act="down"][data-i="0"]');
await page.selectOption('#lvl-H1', 'moderate');
await page.click('[data-act="confirm-sel"]');
await page.screenshot({ path: `${SHOTS}/4-hallazgos.png` });
await page.click('[data-go="5"]:not(.step)');
await page.click('[data-act="report"]');
await page.waitForSelector('#preview');
await page.click('[data-go="6"]:not(.step)');
await page.evaluate(() => { const m = document.querySelector('main'); m.scrollTop = m.scrollHeight; });
const before = await page.evaluate(() => document.querySelector('main').scrollTop);
await page.check('#rv-a'); await page.check('#rv-b');
const after = await page.evaluate(() => document.querySelector('main').scrollTop);
ok(before > 300 && Math.abs(after - before) < 5, `Marcar los criterios de revisión no mueve la pantalla (${before} → ${after})`);
ok(await page.isDisabled('[data-act="approve"]'), 'Sin nombre ni tres confirmaciones no se aprueba');
await page.check('#rv-c'); await page.fill('#rv-name', 'Revisor de prueba');
await page.click('[data-act="approve"]');
await page.waitForSelector('[data-act="accept-alert"]');
ok(true, 'Aprobación genera nota de alerta (>400 palabras aceptada)');
const alertPrompt = await page.evaluate(() => window.__alertPrompt);
ok(alertPrompt.includes('a nombre de un condómino') && alertPrompt.includes('c.c. Comité de Vigilancia') && alertPrompt.includes('comprobante del pago SPEI 4471'), 'La nota se redacta según el rol (condómino) e incluye las observaciones');
ok((await page.textContent('.stage-head h1')).includes('Escrito de observaciones a la administración') && (await page.textContent('main')).includes('Preguntas a la administración'), 'Etapa 7 con título y secciones del rol');
await page.click('[data-act="accept-alert"]');
await page.click('[data-go="8"]:not(.step)');
await page.click('[data-act="dl-html"]'); await page.click('[data-act="dl-json"]');
const saved = await page.evaluate(() => window.__saved);
ok(saved.length === 2 && saved[0].data.includes('<svg') && saved[0].data.includes('$566,000.00'), 'HTML descargado con gráficos y mismos saldos');
ok(saved[0].data.includes('Observaciones para la administración') && saved[0].data.includes('comprobante del pago SPEI 4471'), 'Reporte descargado incluye las observaciones para la administración');
ok(saved[0].data.includes('Estado de morosidad por departamento') && saved[0].data.includes('Torre 2 - 202'), 'Reporte descargado con morosidad por departamento');
ok(!/sk-ant|apiKey/.test(saved[1].data) && JSON.parse(saved[1].data).months.length === 3, 'JSON sin credenciales con mapeo');
fs.writeFileSync(`${SHOTS}/reporte.html`, saved[0].data);
await page.click('[data-act="close"]');
await page.reload();
await page.waitForSelector('text=Análisis cerrado');
ok(true, 'Recarga recupera el caso cerrado');
// agregar un PDF nuevo invalida posteriores: se prueba restaurando JSON (renueva aprobaciones)
await page.click('[data-go="1"]');
await page.setInputFiles('#json-in', { name: 'copia.json', mimeType: 'application/json', buffer: Buffer.from(saved[1].data) });
await page.waitForFunction(() => document.querySelector('.stage-head .k')?.textContent.includes('Etapa 2'));
ok(await page.isDisabled('.step[data-go="3"]'), 'Copia restaurada exige renovar confirmación y aprobaciones');
await page.click('.step[data-go="1"]');
await page.click('label.role-card:has(#role-admin)');
await page.click('.step[data-go="2"]');
const adminTxt = await page.textContent('main');
ok(adminTxt.includes('Responde las que puedas con tu documentación') && adminTxt.includes('Puntos pendientes anotados') && !(await page.$('.obs-draft')), 'Administrador: responde directamente y sus pendientes se anotan');
await page.click('#abandon [data-act="new"]');
await page.click('[data-act="new-no"]');
ok((await page.$$('.files li')).length === 0 || (await page.textContent('.stage-head .k')).includes('Etapa 2'), 'Cancelar conserva el análisis');
await page.click('#abandon [data-act="new"]');
await page.click('[data-act="new-yes"]');
await page.waitForFunction(() => document.querySelector('.stage-head .k')?.textContent.includes('Etapa 1'));
ok((await page.$$('.files li')).length === 0 && !(await page.$('#abandon')) && await page.isDisabled('.step[data-go="2"]'), 'Interrumpir descarta el caso y vuelve a la etapa 1 vacía');
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ path: path.join(PDFJS, path.basename(new URL(r.request().url()).pathname)), contentType: 'text/javascript' }));
await mob.addInitScript(MOCK);
await mob.goto('file://' + path.join(ROOT, 'dist/index.html'));
await mob.waitForSelector('#pdf-in', { state: 'attached' });
const sw = await mob.evaluate(() => document.documentElement.scrollWidth);
ok(sw <= 390, `Sin scroll horizontal en móvil (${sw}px)`);
await mob.screenshot({ path: `${SHOTS}/movil.png` });
ok(errs.length === 0, 'Sin errores de ejecución: ' + errs.join(' | '));
console.log('Llamadas simuladas:', (await page.evaluate(() => window.__calls)).join(', '));
await browser.close();
