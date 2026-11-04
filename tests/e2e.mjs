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
  const MES = { ENE: '01', FEB: '02' };
  window.__calls = []; window.__saved = [];
  async function sample(prompt) {
    await new Promise(r => setTimeout(r, 150));
    const op = (prompt.match(/OPERACIÓN: (\w+)/) || [])[1];
    window.__calls.push(op);
    let out;
    if (op === 'interpret') {
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
      out = { period, bank: 'Banco de prueba', accountType: 'Cheques', currency: 'MXN', initialBalance: val(/SALDO ANTERIOR\s+([\d,.]+)/), finalBalance: val(/SALDO FINAL\s+([\d,.]+)/), reportedIncome: val(/DEPOSITOS\s+([\d,.]+)/), reportedExpense: val(/RETIROS\s+([\d,.]+)/), movements, questions: [{ prompt: '¿El estado incluye otra cuenta de inversión del condominio?', blocking: false }], notes: [] };
    } else if (op === 'analyze') {
      const c = JSON.parse(between(prompt, 'candidatos_motor'));
      out = { executiveSummary: 'Resumen simulado del diagnóstico para pruebas automatizadas del flujo.', trends: ['Tendencia simulada'], comparabilityNote: '', findings: c.slice(0, 5).map((a, i) => ({ id: `H${i + 1}`, title: a.title, description: a.detail, evidence: a.evidence, category: 'NO_CLASIFICADO', level: a.level, kind: a.kind, impact: 'Impacto simulado', recommendation: 'Recomendación simulada', missingData: '', hypotheses: [{ text: 'Hipótesis simulada cuantificada', quantified: true }], sourceRule: a.id })) };
    } else if (op === 'report') {
      const f = JSON.parse(between(prompt, 'hallazgos_confirmados'));
      out = { executiveSummary: 'Resumen ejecutivo simulado con extensión suficiente para pasar la validación del reporte.', flowAnalysis: 'Flujo simulado.', expenseAnalysis: 'Egresos simulados.', fundsAnalysis: 'Fondos simulados.', delinquencyAnalysis: 'Sin datos de morosidad.', findings: f.map(x => ({ id: x.id, title: x.title, level: x.level, narrative: 'Narrativa simulada.', evidenceSummary: 'Evidencia simulada.', recommendation: 'Recomendación simulada.', missingData: '' })), limitations: 'Limitaciones simuladas.' };
    } else if (op === 'alert') {
      const f = JSON.parse(between(prompt, 'hallazgos_confirmados'));
      out = { addressee: 'Comité de Vigilancia', sender: 'Análisis IA', reference: 'Prueba', date: 'hoy', body: Array(420).fill('texto').join(' '), findings: f.map(x => ({ id: x.id, title: x.title, level: x.level, risk: 'riesgo', requiredAction: 'acción', suggestedDeadline: '15 días' })), questionsForCommittee: ['¿P1?', '¿P2?', '¿P3?'], legalWarning: 'Los hallazgos Críticos no atendidos deben escalarse a la Asamblea conforme al artículo 39 de la LPCIDF.' };
    } else out = 'OK';
    return { text: typeof out === 'string' ? out : JSON.stringify(out), truncated: false };
  }
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

await page.fill('#c-name', 'Condominio de prueba (sintético)');
await page.fill('#c-units', '140'); await page.press('#c-units', 'Tab');
await page.fill('#c-fee', '850'); await page.press('#c-fee', 'Tab');
await page.setInputFiles('#pdf-in', [path.join(ROOT, 'tests/fixtures/sintetico-2026-01.pdf'), path.join(ROOT, 'tests/fixtures/sintetico-2026-02.pdf')]);
await page.waitForFunction(() => document.querySelectorAll('.files li').length === 2 && !document.querySelector('.files .spinner'));
ok((await page.textContent('.files')).includes('2026-01'), 'PDF.js extrae texto y detecta período');
await page.check('#consent');
await page.screenshot({ path: `${SHOTS}/1-carga.png` });
await page.click('[data-act="interpret"]');
await page.waitForSelector('text=Confirmar datos >> nth=0');
await page.waitForFunction(() => document.querySelector('.stage-head .k')?.textContent.includes('Etapa 2'));
ok(true, 'Interpretación de 2 meses y paso a confirmar datos');
const body2 = await page.textContent('main');
ok(body2.includes('Diferencia') && body2.includes('Discontinuidad'), 'Se señalan descuadre y discontinuidad');
ok(body2.includes('Bloqueante'), 'Pregunta bloqueante por egreso sin categoría > $5,000');
for (const k of ['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity']) await page.check(`#chk-${k}`);
ok(await page.isDisabled('[data-act="confirm"]'), 'La casilla general no permite avanzar con pregunta bloqueante');
await page.screenshot({ path: `${SHOTS}/2-confirmar.png`, fullPage: false });
const qsel = await page.$('select[data-qcat]');
await qsel.selectOption('EV_MANTENIMIENTO');
await page.waitForTimeout(200);
for (const k of ['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity']) if (!(await page.isChecked(`#chk-${k}`))) await page.check(`#chk-${k}`);
// pregunta informativa de texto sin responder: no bloquea
ok(!(await page.isDisabled('[data-act="confirm"]')), 'Al responder la pregunta se habilita confirmar');
await page.click('[data-act="confirm"]');
await page.click('[data-go="3"]:not(.step)');
await page.click('[data-act="analyze"]');
await page.waitForSelector('text=Hallazgos propuestos');
const d = await page.textContent('main');
ok(/Descuadre aritmético en 2026-02/.test(d) && d.includes('$1,000.00'), 'Regla de cuadre: crítico por $1,000');
ok(/Discontinuidad de saldo 2026-01 → 2026-02/.test(d) && d.includes('$2,000.00'), 'Regla de continuidad: crítico por $2,000');
ok(/Pago duplicado probable/.test(d), 'Regla de duplicado probable (jardinería)');
ok(/Sin pago de honorarios/.test(d), 'Regla de honorarios ausentes');
await page.screenshot({ path: `${SHOTS}/3-diagnostico.png`, fullPage: true });
await page.click('text=Continuar a hallazgos');
ok((await page.$$('.finding.sel')).length === 0, 'Selección no precargada');
for (const id of ['H2', 'H1', 'H3']) await page.click(`[data-act="toggle-sel"][data-id="${id}"]`);
await page.click('[data-act="down"][data-i="0"]');
await page.selectOption('#lvl-H1', 'moderate');
await page.click('[data-act="confirm-sel"]');
await page.screenshot({ path: `${SHOTS}/4-hallazgos.png` });
await page.click('[data-go="5"]:not(.step)');
await page.click('[data-act="report"]');
await page.waitForSelector('#preview');
await page.click('[data-go="6"]:not(.step)');
await page.check('#rv-a'); await page.check('#rv-b');
ok(await page.isDisabled('[data-act="approve"]'), 'Sin nombre ni tres confirmaciones no se aprueba');
await page.check('#rv-c'); await page.fill('#rv-name', 'Revisor de prueba');
await page.click('[data-act="approve"]');
await page.waitForSelector('[data-act="accept-alert"]');
ok(true, 'Aprobación genera nota de alerta (>400 palabras aceptada)');
await page.click('[data-act="accept-alert"]');
await page.click('[data-go="8"]:not(.step)');
await page.click('[data-act="dl-html"]'); await page.click('[data-act="dl-json"]');
const saved = await page.evaluate(() => window.__saved);
ok(saved.length === 2 && saved[0].data.includes('<svg') && saved[0].data.includes('$566,000.00'), 'HTML descargado con gráficos y mismos saldos');
ok(!/sk-ant|apiKey/.test(saved[1].data) && JSON.parse(saved[1].data).months.length === 2, 'JSON sin credenciales con mapeo');
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
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ path: path.join(PDFJS, path.basename(new URL(r.request().url()).pathname)), contentType: 'text/javascript' }));
await mob.addInitScript(MOCK);
await mob.goto('file://' + path.join(ROOT, 'dist/index.html'));
await mob.waitForSelector('#c-name');
const sw = await mob.evaluate(() => document.documentElement.scrollWidth);
ok(sw <= 390, `Sin scroll horizontal en móvil (${sw}px)`);
await mob.screenshot({ path: `${SHOTS}/movil.png` });
ok(errs.length === 0, 'Sin errores de ejecución: ' + errs.join(' | '));
console.log('Llamadas simuladas:', (await page.evaluate(() => window.__calls)).join(', '));
await browser.close();
