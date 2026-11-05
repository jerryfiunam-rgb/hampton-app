// Interfaz y orquestación del workflow de 8 etapas.
import * as E from '../lib/condominio.mjs';
import { buildPrompt, parseJsonText, validateResult } from '../lib/ai.mjs';
import { itemsToLines, checkFileLimits, detectPeriod, PDF_MAX_PAGES, MAX_FILES } from '../lib/pdf-parser.mjs';
import { esc, svgBalance, svgComposition, flowTable, fundsTable, kpiGrid, standaloneReport, alertBody } from './report.mjs';

const STORE_KEY = 'hampton-analisis-v1';
const SCHEMA = 'condominio-analisis-estados-cuenta';
const TIMEOUT_MS = { interpret: 300000, analyze: 180000, report: 180000, alert: 180000, test: 60000 };
const STAGES = [
  { n: 1, t: 'Carga de PDFs', s: 'Carga' },
  { n: 2, t: 'Confirmar datos', s: 'Revisión' },
  { n: 3, t: 'Diagnóstico', s: 'Motor + IA' },
  { n: 4, t: 'Hallazgos', s: 'Selección' },
  { n: 5, t: 'Reporte', s: 'Borrador' },
  { n: 6, t: 'Verificación humana', s: 'Aprobación' },
  { n: 7, t: 'Nota de alerta', s: 'Comité' },
  { n: 8, t: 'Entrega', s: 'Descargas' },
];

// Datos fijos del condominio (no se capturan en cada análisis).
const CONDO = Object.freeze({
  name: 'Condominio Hampton Court',
  address: 'Mar de la Tranquilidad 35, Colonia Los Olivos, Coyoacán, Ciudad de México',
  context: 'Condominio Hampton Court, ubicado en Mar de la Tranquilidad 35, Colonia Los Olivos, Coyoacán, Ciudad de México, con 80 departamentos.',
  administrator: '', units: 80, monthlyFee: '', delinquentDebt: '',
});
const LOGO = '__LOGO_DATA_URI__';
const PAGE_IMAGES = new Map(); // fileId -> [{number, blob}] (solo en memoria; no se guarda en el navegador)

const now = () => new Date().toISOString();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const $ = (sel, root = document) => root.querySelector(sel);

function fresh() {
  return {
    schema: SCHEMA, version: 1, caseId: uid(), createdAt: now(), stage: 1,
    condo: { ...CONDO },
    consent: false,
    files: [], months: [], fundOpenings: {},
    meta: { bank: '', accountType: '', currency: 'MXN' },
    answers: {}, appliedAnswers: {}, corrections: [],
    confirmation: null, diagnosis: null,
    selection: [], selectionConfirmedAt: null,
    report: null, observationsDraft: '',
    review: null, alert: null, closedAt: null,
    events: [], calls: [],
  };
}

// ---------- Persistencia ----------
let storageOk = true;
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s?.schema !== SCHEMA) return null;
    return { ...fresh(), ...s, condo: { ...CONDO } };
  } catch { storageOk = false; return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); storageOk = true; }
  catch { storageOk = false; }
}
let S = load() || fresh();
const restored = S.events.length > 0;

function log(type, detail = '') { S.events.push({ at: now(), type, detail: String(detail).slice(0, 300) }); save(); }

// ---------- Invalidación en cascada ----------
function invalidate(from) {
  const order = ['mapping', 'confirmation', 'diagnosis', 'selection', 'report', 'review', 'alert', 'closed'];
  const i = order.indexOf(from);
  const touched = [];
  const drop = (k, fn) => { if (order.indexOf(k) > i || k === from) { if (fn()) touched.push(k); } };
  drop('confirmation', () => { const had = !!S.confirmation; S.confirmation = null; return had && from !== 'confirmation'; });
  drop('diagnosis', () => { const had = !!S.diagnosis; S.diagnosis = null; return had; });
  drop('selection', () => { const had = S.selection.length > 0 || S.selectionConfirmedAt; if (from !== 'selection') S.selection = []; S.selectionConfirmedAt = null; return !!had; });
  drop('report', () => { const had = !!S.report; S.report = null; return had; });
  drop('review', () => { const had = !!S.review; S.review = null; return had; });
  drop('alert', () => { const had = !!S.alert; S.alert = null; return had; });
  drop('closed', () => { const had = !!S.closedAt; S.closedAt = null; return had; });
  if (touched.length) log('invalidación', `Por cambio en ${from}: se reinician ${touched.join(', ')}`);
}

// ---------- Estado derivado ----------
const months = () => E.sortMonths(S.months.map(E.recomputeMonth));
const allMovements = () => months().flatMap(m => [...m.movements, ...m.unclassifiedMovements]);
const mappingHash = () => E.hashMapping(S.months);
const confirmed = () => !!S.confirmation && S.confirmation.hash === mappingHash();
function questions() {
  const ms = months();
  const eq = E.engineQuestions(ms);
  const aiq = ms.flatMap(m => m.aiQuestions || []).filter(q => !S.appliedAnswers[q.id]);
  return [...eq, ...aiq];
}
const pendingTextAnswers = () => questions().filter(q => q.kind === 'text' && (S.answers[q.id] || '').trim());
const blockingOpen = () => questions().filter(q => q.blocking && !(q.kind === 'text' && (S.answers[q.id] || '').trim()));
function indicators() { return E.computeIndicators(months(), S.condo, S.fundOpenings); }

function enabled(n) {
  if (n === 1) return true;
  if (n === 2) return S.months.length > 0;
  if (n === 3) return confirmed();
  if (n === 4) return confirmed() && !!S.diagnosis;
  if (n === 5) return enabled(4) && !!S.selectionConfirmedAt;
  if (n === 6) return enabled(5) && !!S.report;
  if (n === 7) return enabled(6) && !!S.review?.approvedAt;
  if (n === 8) return enabled(7) && !!S.alert?.acceptedAt;
  return false;
}
function done(n) {
  return { 1: S.months.length > 0, 2: confirmed(), 3: !!S.diagnosis, 4: !!S.selectionConfirmedAt, 5: !!S.report, 6: !!S.review?.approvedAt, 7: !!S.alert?.acceptedAt, 8: !!S.closedAt }[n];
}
function go(n) { if (!enabled(n)) return; S.stage = n; save(); render(); window.scrollTo({ top: 0 }); }
if (!enabled(S.stage)) S.stage = 1;

// ---------- Conexión con Claude ----------
const AI = { mode: null, sample: null, downloads: null, server: null, model: null, checked: false, error: null };

async function initAI() {
  if (window.claude && typeof window.claude.use === 'function') {
    AI.mode = 'claude.ai';
    try { AI.sample = await window.claude.use('sample'); } catch { AI.sample = null; }
    try { AI.downloads = await window.claude.use('downloads'); } catch { AI.downloads = null; }
    try { const lim = AI.sample ? await AI.sample.limits() : null; AI.maxImages = lim?.images?.maxCount || 0; } catch { AI.maxImages = 0; }
    AI.model = 'Claude (cuenta de claude.ai del usuario)';
    if (!AI.sample) AI.error = 'Esta vista no permite llamar a Claude. Abre la aplicación en claude.ai con tu sesión iniciada.';
  } else {
    AI.mode = 'server';
    try {
      const r = await fetch('/api/status', { credentials: 'same-origin' });
      const j = await r.json();
      AI.server = j; AI.model = j.model; AI.maxImages = 8;
    } catch { AI.error = 'No se pudo consultar el servidor (/api/status).'; }
  }
  AI.checked = true;
  render();
}
const aiReady = () => AI.mode === 'claude.ai' ? !!AI.sample : !!AI.server?.connected;

let busy = null; // {key, startedAt, msg, ctl}
const errors = {}; // por acción
let tick = null;

function errorText(code, msg) {
  const map = {
    not_granted: 'No se autorizó el uso de Claude en esta página. Vuelve a intentarlo y acepta el permiso de claude.ai.',
    rate_limited: 'Se alcanzó el límite de uso. Espera un momento y reintenta; tus datos se conservan.',
    session_expired: 'La sesión de claude.ai expiró. Recarga la página e inicia sesión; el avance se conserva en este navegador.',
    sampling_disabled: 'El uso de Claude desde páginas está desactivado para tu cuenta u organización.',
    prompt_too_large: 'El texto enviado es demasiado grande. Divide el PDF por meses o reduce páginas.',
    cancelled: 'Operación cancelada. Puedes reintentar sin perder lo completado.',
    timeout: 'Se superó el tiempo máximo de espera. Reintenta; no se perdió el avance.',
    truncated: 'La respuesta quedó truncada (límite de salida). Reintenta; si persiste, divide el PDF.',
    invalid_json: 'Claude devolvió una respuesta que no es JSON válido. Reintenta.',
    html_response: 'El servidor devolvió HTML en lugar de datos. Revisa la conexión y reintenta.',
    invalid_result: 'La respuesta no cumple el esquema requerido y se rechazó; el resultado anterior se conserva.',
    key_rejected: 'Anthropic rechazó la clave API. Reemplázala en «Conectar Claude».',
    billing: 'La cuenta API no tiene saldo o permisos para el modelo.',
    interrupted: 'La conexión se interrumpió. Reintenta; tus datos y la conexión se conservan.',
    upstream_error: 'Falla temporal del servicio. Reintenta; tus datos y la conexión se conservan.',
    refused: 'Claude no completó la solicitud con este contenido.',
    empty_completion: 'Claude no produjo texto. Reintenta.',
    not_connected: 'Primero conecta Claude.',
  };
  return (map[code] || 'Error inesperado.') + (msg && !map[code] ? ` ${msg}` : '') + (code === 'invalid_result' && msg ? ` Detalle: ${msg}` : '');
}

async function callAI(op, payload, key, { images = [], label = '' } = {}) {
  if (!aiReady()) { const e = new Error('not_connected'); e.code = 'not_connected'; throw e; }
  const { system, user } = buildPrompt(op, payload);
  const ctl = new AbortController();
  busy = { key, startedAt: Date.now(), msg: label ? `${label}: iniciando…` : 'Iniciando…', label, ctl, chars: 0 };
  render();
  tick = setInterval(() => { if (busy) updateBusy(); }, 8000);
  const timer = setTimeout(() => { ctl.abort(); busy && (busy.timedOut = true); }, TIMEOUT_MS[op] || 180000);
  const started = now();
  try {
    let text, usage = null, model = AI.model;
    if (AI.mode === 'claude.ai') {
      try {
        const res = await AI.sample(`${system}\n\n${user}`, {
          modelTier: op === 'interpret' ? 'default' : 'complex', cache: false, signal: ctl.signal,
          ...(images.length ? { images } : {}),
          onText: ({ text }) => { if (busy) { busy.chars = text.length; busy.msg = `${busy.label ? busy.label + ': ' : ''}recibiendo respuesta…`; updateBusy(); } },
        });
        if (res.truncated) { const e = new Error('truncated'); e.code = 'truncated'; throw e; }
        text = res.text;
        model = res.modelApplied || model;
      } catch (e) {
        if (e?.code === 'cancelled' && busy?.timedOut) { const t = new Error('timeout'); t.code = 'timeout'; throw t; }
        throw e;
      }
    } else {
      ({ text, usage, model } = await serverAI(op, payload, ctl.signal, images));
    }
    const parsed = parseJsonText(text);
    const result = validateResult(op, parsed, payload);
    S.calls.push({ action: op + (images.length ? ` (+${images.length} imágenes)` : ''), model, at: started, finishedAt: now(), inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, approxInputChars: system.length + user.length, approxOutputChars: text.length });
    save();
    return result;
  } catch (e) {
    if (busy?.timedOut && e.code !== 'timeout') { e.code = 'timeout'; }
    throw e;
  } finally {
    clearTimeout(timer); clearInterval(tick); busy = null;
  }
}

const blobToBase64 = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(b); });
async function serverAI(op, payload, signal, images = []) {
  const imgs = await Promise.all(images.map(blobToBase64));
  const r = await fetch('/api/ai', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, payload, images: imgs }), signal });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/html')) { const e = new Error('html'); e.code = 'html_response'; throw e; }
  if (!r.ok && !ct.includes('event-stream')) { let j = {}; try { j = await r.json(); } catch {} const e = new Error(j.message || r.statusText); e.code = j.code || 'upstream_error'; throw e; }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let final = null;
  try {
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (chunk.match(/^event: (.*)$/m) || [])[1]; const data = (chunk.match(/^data: (.*)$/m) || [])[1];
        if (!ev) continue;
        const j = data ? JSON.parse(data) : {};
        if (ev === 'progress' && busy) { busy.msg = j.message || busy.msg; busy.chars = j.chars ?? busy.chars; updateBusy(); }
        if (ev === 'error') { const e = new Error(j.message); e.code = j.code; throw e; }
        if (ev === 'result') final = j;
      }
    }
  } catch (e) { if (e.code) throw e; if (signal.aborted) { const t = new Error('timeout'); t.code = busy?.timedOut ? 'timeout' : 'cancelled'; throw t; } const x = new Error('interrupted'); x.code = 'interrupted'; throw x; }
  if (!final) { const e = new Error('interrupted'); e.code = 'interrupted'; throw e; }
  return final;
}

function updateBusy() {
  const el = document.getElementById('busy-' + busy?.key);
  if (!el || !busy) return;
  const secs = Math.round((Date.now() - busy.startedAt) / 1000);
  el.innerHTML = `<span><span class="spinner" aria-hidden="true"></span>${esc(busy.msg)} · ${secs} s${busy.chars ? ` · ${busy.chars.toLocaleString('es-MX')} caracteres recibidos` : ''}</span><span class="sub">Puedes usar otra pestaña; no cierres ni recargues esta.</span>`;
}

// ---------- Lectura de PDF ----------
// Una página se trata como escaneada si casi no tiene texto, o si contiene imágenes y poco texto.
// Esas páginas se renderizan a JPEG (solo en memoria) y Claude las lee como imagen.
const SCAN_TEXT_MIN = 120, MIXED_TEXT_MAX = 1500;
async function pageHasImages(page) {
  try {
    const ops = await page.getOperatorList();
    const O = window.pdfjsLib.OPS;
    const img = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageXObjectRepeat, O.paintInlineImageXObjectGroup, O.paintJpegXObject].filter(x => x !== undefined));
    return ops.fnArray.some(fn => img.has(fn));
  } catch { return false; }
}
async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2.5, 1700 / Math.max(base.width, base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  canvas.width = canvas.height = 0;
  return blob;
}
async function extractPdf(file, id, onPage) {
  const lim = checkFileLimits(file);
  if (lim) throw Object.assign(new Error(lim), { code: 'limit' });
  if (!window.pdfjsLib) throw new Error('No se cargó el lector de PDF (PDF.js). Revisa tu conexión y recarga.');
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false, disableAutoFetch: true, enableXfa: false }).promise;
  if (doc.numPages > PDF_MAX_PAGES) { await doc.destroy(); throw Object.assign(new Error(`«${file.name}» tiene ${doc.numPages} páginas; el límite es ${PDF_MAX_PAGES}. No se procesaron datos parciales.`), { code: 'limit' }); }
  const pages = [], images = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onPage?.(i, doc.numPages);
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = itemsToLines(tc.items).join('\n');
    const len = text.replace(/\s/g, '').length;
    const scanned = len < SCAN_TEXT_MIN || (len < MIXED_TEXT_MAX && await pageHasImages(page));
    if (scanned) images.push({ number: i, blob: await renderPage(page) });
    pages.push({ number: i, text, scanned });
    page.cleanup();
  }
  await doc.destroy();
  if (images.length) PAGE_IMAGES.set(id, images);
  const all = pages.map(p => p.text).join('\n');
  return { id, fileName: file.name, size: file.size, period: detectPeriod(all), pages, extractedAt: now(), status: 'extraído' };
}

async function addFiles(list) {
  const arr = [...list];
  errors.files = null;
  if (S.files.length + arr.length > MAX_FILES) { errors.files = `Puedes cargar hasta ${MAX_FILES} PDFs por análisis (ya hay ${S.files.length}).`; render(); return; }
  for (const f of arr) {
    const tmp = { id: uid(), fileName: f.name, size: f.size, status: 'leyendo', pages: [] };
    S.files.push(tmp); render();
    try {
      const out = await extractPdf(f, tmp.id, (i, n) => { const el = document.querySelector(`[data-reading="${tmp.id}"]`); if (el) el.textContent = `Leyendo página ${i} de ${n}…`; });
      Object.assign(tmp, out);
      const sc = out.pages.filter(p => p.scanned).length;
      log('pdf_extraido', `${f.name}: ${out.pages.length} páginas (${sc} escaneadas), período detectado ${out.period || 'no detectado'}`);
      if (S.months.length) invalidate('mapping');
    } catch (e) {
      tmp.status = 'error'; tmp.error = e.message || String(e); tmp._file = f;
      log('pdf_error', `${f.name}: ${tmp.error}`);
    }
    save(); render();
  }
}

// ---------- Acciones de IA por etapa ----------
function interpretChunks(f) {
  const imgs = PAGE_IMAGES.get(f.id) || [];
  const max = Math.max(1, Math.min(AI.maxImages || 5, 20));
  const chunks = [{ pages: [], images: [] }];
  for (const p of f.pages) {
    let cur = chunks.at(-1);
    const img = p.scanned ? imgs.find(x => x.number === p.number) : null;
    if (img && cur.images.length >= max) { cur = { pages: [], images: [] }; chunks.push(cur); }
    cur.pages.push({ ...p, imageIndex: img ? cur.images.length + 1 : null, imageMissing: p.scanned && !img });
    if (img) cur.images.push(img.blob);
  }
  return chunks;
}

// Une las partes de un mismo estado de cuenta leído en varios lotes.
function mergeParts(parts, f) {
  const first = v => parts.map(p => p[v]).find(x => x !== null && x !== undefined && x !== '');
  const lastFinal = [...parts].reverse().map(p => p.finalBalance).find(x => x !== null && x !== undefined);
  const period = parts.map(p => p.period).find(x => x && x !== f.period) || parts[0].period;
  let n = 0;
  const movements = parts.flatMap(p => [...p.movements, ...p.unclassifiedMovements]).map(m => ({ ...m, id: `${period}-${String(++n).padStart(3, '0')}` }));
  let q = 0;
  const aiQuestions = parts.flatMap(p => p.aiQuestions || []).map(x => ({ ...x, id: `q-ai-${period}-${++q}`, period }));
  return E.recomputeMonth({ ...parts[0], period, initialBalance: parts[0].initialBalance ?? first('initialBalance'), finalBalance: lastFinal ?? null, reportedIncome: first('reportedIncome') ?? null, reportedExpense: first('reportedExpense') ?? null, pettyCashBalance: first('pettyCashBalance') ?? null, bank: first('bank') || '', accountType: first('accountType') || '', movements, unclassifiedMovements: [], aiQuestions, notes: parts.flatMap(p => p.notes || []) });
}

async function runInterpret(onlyIds = null) {
  const targets = S.files.filter(f => f.status !== 'error' && f.pages?.length && (onlyIds ? onlyIds.includes(f.id) : !S.months.some(m => m.fileId === f.id)));
  if (!targets.length) { errors.interpret = 'No hay PDFs nuevos por interpretar.'; render(); return; }
  errors.interpret = null;
  for (const f of targets) {
    try {
      const prev = S.months.find(m => m.fileId === f.id);
      const hasScans = f.pages.some(p => p.scanned);
      if (hasScans && !PAGE_IMAGES.has(f.id) && !prev) throw Object.assign(new Error('Las páginas escaneadas no se conservan al recargar. Quita el archivo y vuelve a cargar el PDF.'), { code: 'reload_pdf' });
      if (hasScans && PAGE_IMAGES.has(f.id) && AI.mode === 'claude.ai' && !AI.maxImages) throw Object.assign(new Error('Esta vista no permite enviar imágenes a Claude para leer las páginas escaneadas.'), { code: 'images_unavailable' });
      const answers = prev ? (prev.aiQuestions || []).filter(q => S.answers[q.id]).map(q => ({ question: q.prompt, answer: S.answers[q.id] })) : [];
      const chunks = interpretChunks(f);
      const parts = [];
      for (let i = 0; i < chunks.length; i++) {
        const label = chunks.length > 1 ? `${f.fileName} · parte ${i + 1} de ${chunks.length}` : f.fileName;
        parts.push(await callAI('interpret', { file: { ...f, pages: chunks[i].pages }, part: chunks.length > 1 ? { index: i + 1, total: chunks.length } : null, condo: condoForAI(), previous: prev ? slimMonth(prev) : null, answers }, 'interpret', { images: chunks[i].images, label }));
      }
      const month = parts.length === 1 ? parts[0] : mergeParts(parts, f);
      const scannedPages = new Set(f.pages.filter(p => p.scanned).map(p => p.number));
      for (const m of [...month.movements, ...month.unclassifiedMovements]) m.fromScan = scannedPages.has(m.sourcePageNumber);
      const errs = E.validateMonthMapping(month);
      if (errs.length) throw Object.assign(new Error(errs.slice(0, 3).join(' ')), { code: 'invalid_result' });
      if (S.months.some(m => m.period === month.period && m.fileId !== f.id)) throw Object.assign(new Error(`El período ${month.period} ya está cargado con otro PDF. Elimina el duplicado.`), { code: 'duplicate_period' });
      // Sustituye solo si la interpretación nueva es válida.
      if (prev) for (const q of prev.aiQuestions || []) if (S.answers[q.id]) S.appliedAnswers[q.id] = { answer: S.answers[q.id], at: now() };
      S.months = S.months.filter(m => m.fileId !== f.id).concat(month);
      f.period = month.period; f.status = 'interpretado';
      if (!S.meta.bank && month.bank) S.meta.bank = month.bank;
      if (!S.meta.accountType && month.accountType) S.meta.accountType = month.accountType;
      invalidate('mapping');
      log(prev ? 'reinterpretación' : 'interpretación', `${f.fileName} → ${month.period}: ${month.movements.length + month.unclassifiedMovements.length} movimientos${scannedPages.size ? ` (${scannedPages.size} páginas escaneadas leídas como imagen)` : ''}`);
    } catch (e) {
      errors.interpret = `${f.fileName}: ${['reload_pdf', 'images_unavailable', 'duplicate_period'].includes(e.code) ? e.message : errorText(e.code, e.message)}`;
      log('error_ia', `interpret ${f.fileName}: ${e.code || ''} ${e.message}`);
      save(); render(); return false;
    }
    save(); render();
  }
  return true;
}
const slimMonth = m => ({ period: m.period, initialBalance: m.initialBalance, finalBalance: m.finalBalance, movements: [...m.movements, ...m.unclassifiedMovements].map(x => ({ date: x.date, concept: x.concept, amount: x.amount, type: x.type, category: x.category, fund: x.fund })) });

async function runAnalyze() {
  errors.analyze = null;
  const ms = months();
  const ind = indicators();
  const anomalies = E.detectAnomalies(ms, ind);
  const movs = allMovements().map(m => ({ id: m.id, date: m.date, concept: m.concept, amount: m.amount, type: m.type, category: m.category, fund: m.fund }));
  try {
    const ai = await callAI('analyze', { condo: condoForAI(), indicators: ind, anomalies, movements: movs }, 'analyze');
    S.diagnosis = { at: now(), hash: mappingHash(), indicators: ind, anomalies, ai };
    invalidate('selection'); S.selection = [];
    log('diagnóstico', `${ai.findings.length} hallazgos propuestos; ${anomalies.length} reglas disparadas`);
  } catch (e) { errors.analyze = errorText(e.code, e.message); log('error_ia', `analyze: ${e.code || ''} ${e.message}`); }
  save(); render();
}
const condoForAI = () => ({ name: CONDO.name, address: CONDO.address, context: CONDO.context, units: CONDO.units, bank: S.meta.bank, accountType: S.meta.accountType, currency: S.meta.currency });

function selectedFindings() {
  const props = S.diagnosis?.ai?.findings || [];
  const mv = new Map(allMovements().map(m => [m.id, m]));
  return S.selection.map(s => {
    const p = props.find(f => f.id === s.id);
    return { ...p, level: s.level, acceptedHypotheses: (p.hypotheses || []).filter((_, k) => (s.acceptedHypotheses || []).includes(k)), evidenceMovements: (p.evidence || []).map(id => mv.get(id)).filter(Boolean).map(m => ({ id: m.id, date: m.date, concept: m.concept, amount: m.amount, type: m.type })) };
  });
}

async function runReport() {
  errors.report = null;
  const obs = S.observationsDraft || '';
  try {
    const ai = await callAI('report', { condo: condoForAI(), indicators: indicators(), diagnosis: { executiveSummary: S.diagnosis.ai.executiveSummary, trends: S.diagnosis.ai.trends, comparabilityNote: S.diagnosis.ai.comparabilityNote }, findings: selectedFindings(), observations: obs }, 'report');
    invalidate('report');
    S.report = { at: now(), ai, observations: obs, status: 'draft' };
    log('reporte', 'Reporte generado (borrador para revisión)');
  } catch (e) { errors.report = errorText(e.code, e.message); log('error_ia', `report: ${e.code || ''} ${e.message}`); }
  save(); render();
}

async function runAlert() {
  errors.alert = null;
  const ind = indicators();
  try {
    const ai = await callAI('alert', { condo: condoForAI(), period: ind.periodFrom === ind.periodTo ? ind.periodFrom : `${ind.periodFrom} a ${ind.periodTo}`, date: new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' }), report: S.report.ai, findings: selectedFindings(), indicators: { months: ind.months, committedFunds: ind.committedFunds, freeBalance: ind.freeBalance, bankBalance: ind.bankBalance } }, 'alert');
    S.alert = { at: now(), ai, acceptedAt: null };
    log('nota_alerta', 'Nota de alerta generada');
  } catch (e) { errors.alert = errorText(e.code, e.message); log('error_ia', `alert: ${e.code || ''} ${e.message}`); }
  save(); render();
}

async function testConnection() {
  errors.connect = null;
  if (AI.mode === 'claude.ai') {
    if (!AI.sample) { errors.connect = AI.error; render(); return; }
    busy = { key: 'connect', startedAt: Date.now(), msg: 'Solicitando permiso a claude.ai…' }; render();
    try {
      const r = await AI.sample('Responde únicamente con la palabra OK.', { modelTier: 'quick', cache: false });
      AI.verified = /ok/i.test(r.text);
      log('conexión', 'Claude verificado mediante la cuenta de claude.ai');
    } catch (e) { errors.connect = errorText(e.code, e.message); }
    busy = null; render();
  } else openConnectDialog();
}

// ---------- Conexión de servidor (clave API) ----------
function openConnectDialog() {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="cd-t"><h2 id="cd-t">Conectar Claude</h2>
  <p class="lead">Ingresa una clave de la API de Anthropic (console.anthropic.com). La suscripción al chat de Claude es distinta de la API: el consumo de este análisis se cobra a la cuenta API de la clave.</p>
  <label class="f">Clave API<input type="password" id="cd-key" autocomplete="off" placeholder="sk-ant-…"></label>
  <div class="status" id="cd-status"></div>
  <div class="row"><button class="btn primary" id="cd-save">Verificar y guardar</button>${AI.server?.connected ? '<button class="btn danger" id="cd-del">Eliminar clave guardada</button>' : ''}<button class="btn ghost" id="cd-close">Cancelar</button></div></div>`;
  document.body.append(bg);
  $('#cd-key').focus();
  $('#cd-close').onclick = () => bg.remove();
  $('#cd-save').onclick = async () => {
    const st = $('#cd-status'); st.className = 'status'; st.textContent = 'Verificando con Anthropic…'; $('#cd-save').disabled = true;
    try {
      const r = await fetch('/api/connect', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: $('#cd-key').value.trim() }) });
      const j = await r.json();
      if (!r.ok || !j.connected) throw Object.assign(new Error(j.message), { code: j.code });
      AI.server = j; AI.model = j.model; log('conexión', `Clave verificada y guardada (modelo ${j.model})`);
      bg.remove(); render();
    } catch (e) { st.className = 'status err'; st.textContent = errorText(e.code, e.message); $('#cd-save').disabled = false; }
  };
  const del = $('#cd-del');
  if (del) del.onclick = async () => {
    await fetch('/api/disconnect', { method: 'POST', credentials: 'same-origin' });
    AI.server = { ...AI.server, connected: false }; log('conexión', 'Clave eliminada'); bg.remove(); render();
  };
}

// ---------- Descargas ----------
async function download(filename, data, mime) {
  try {
    if (AI.mode === 'claude.ai') {
      if (!AI.downloads) throw Object.assign(new Error(''), { code: 'unavailable' });
      await AI.downloads.save({ filename, data });
    } else {
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    log('descarga', filename);
    errors.download = null;
  } catch (e) {
    errors.download = e.code === 'declined' ? 'Descarga cancelada.' : `No se pudo descargar (${e.code || e.message}).`;
  }
  render();
}
const slug = s => String(s || 'condominio').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function exportJSON() {
  const copy = JSON.parse(JSON.stringify(S));
  copy.exportedAt = now();
  copy.note = 'Copia del avance sin credenciales. Al restaurarla se exige renovar consentimiento y aprobaciones.';
  for (const f of copy.files) delete f._file;
  return JSON.stringify(copy, null, 2);
}

function restoreJSON(text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('El archivo no es JSON válido.'); }
  if (j?.schema !== SCHEMA || j.version !== 1) throw new Error('El archivo no es una copia de esta aplicación (esquema o versión distintos).');
  if (!Array.isArray(j.months) || !Array.isArray(j.files) || typeof j.condo !== 'object') throw new Error('La copia está incompleta: faltan condominio, archivos o mapeo.');
  for (const m of j.months) { const errs = E.validateMonthMapping(m); if (errs.length) throw new Error(`Mapeo inválido en ${m.period}: ${errs[0]}`); }
  for (const k of ['apiKey', 'key', 'token']) delete j[k];
  const n = { ...fresh(), ...j, condo: { ...CONDO } };
  n.consent = false; n.confirmation = null; n.review = null; n.closedAt = null;
  if (n.alert) n.alert.acceptedAt = null;
  n.selectionConfirmedAt = null;
  n.events = [...(j.events || []), { at: now(), type: 'restauración', detail: 'Copia JSON restaurada: se requiere renovar consentimiento, confirmación de datos y aprobaciones.' }];
  n.stage = n.months.length ? 2 : 1;
  S = n; save(); render();
}

// ---------- Render ----------
const app = () => document.getElementById('app');
const src = k => `<span class="src ${k}">${{ pdf: 'PDF', motor: 'Motor', user: 'Usuario', ia: 'IA' }[k]}</span>`;
const legend = () => `<div class="legend"><span>Origen de cada dato:</span>${src('pdf')} extraído del estado de cuenta ${src('motor')} cálculo del motor ${src('user')} anotación del usuario ${src('ia')} análisis de Claude</div>`;
const statusFor = key => busy?.key === key ? `<div class="status" id="busy-${key}" role="status" aria-live="polite"></div>` : errors[key] ? `<div class="status err" role="alert">${esc(errors[key])}</div>` : '';
const dis = (cond) => (cond || !!busy) ? 'disabled' : '';

function render() {
  const root = app();
  if (!root) return;
  const focusId = document.activeElement?.id;
  root.innerHTML = `
  <header class="topbar">
    <img class="logo" src="${LOGO}" alt="Escudo del Condominio Hampton Court" width="84" height="85">
    <h1 class="apptitle">Análisis de estados de cuenta - <span>Condominio Hampton Court</span></h1>
    <span class="addr">${esc(CONDO.address)} · ${CONDO.units} departamentos</span>
    <span class="conn">${connBadge()}</span>
  </header>
  <div class="shell">
    <nav class="rail" aria-label="Etapas del análisis"><ol>${STAGES.map(st => `<li><button class="step ${done(st.n) ? 'done' : ''}" data-go="${st.n}" ${enabled(st.n) ? '' : 'disabled'} ${S.stage === st.n ? 'aria-current="step"' : ''}><span class="n">${done(st.n) ? '✓' : st.n}</span><span class="t">${st.t}<span class="s">${done(st.n) ? 'Completada' : enabled(st.n) ? st.s : 'Bloqueada'}</span></span></button></li>`).join('')}</ol>
    <p class="note">El análisis se guarda solo en este navegador. Sin sincronización entre equipos: usa la copia JSON para cambiar de equipo.</p></nav>
    <main><div class="wrap">${banners()}${stageView()}${logView()}</div></main>
  </div>`;
  if (busy) updateBusy();
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  wireAfterRender();
}

function connBadge() {
  if (!AI.checked) return '<span class="dot"></span>Comprobando conexión…';
  if (AI.mode === 'claude.ai') return AI.sample ? `<span class="dot ok"></span>Claude vía claude.ai${AI.verified ? ' · verificado' : ''}` : '<span class="dot err"></span>Claude no disponible';
  return AI.server?.connected ? `<span class="dot ok"></span>Claude conectado · ${esc(AI.server.model)}` : '<span class="dot warn"></span>Claude sin conectar';
}

function banners() {
  const b = [];
  if (!storageOk) b.push('<div class="banner err" role="alert">No se puede guardar el avance en este navegador (almacenamiento bloqueado o lleno). Descarga la copia JSON con frecuencia.</div>');
  if (restored && S.stage === 1 && S.months.length && !banners.shown) { b.push(`<div class="banner ok">Se recuperó el caso guardado en este navegador (${esc(S.condo.name || 'sin nombre')}, ${S.months.length} meses). La conexión con Claude es independiente del avance local.</div>`); banners.shown = true; }
  if (S.closedAt) b.push(`<div class="banner ok">Análisis cerrado el ${esc(new Date(S.closedAt).toLocaleString('es-MX'))}. Puedes consultar y descargar; para otro período usa «Nuevo análisis».</div>`);
  return b.join('');
}

function head(n, title, lead) {
  return `<div class="stage-head"><span class="k">Etapa ${n} de 8</span><h1>${title}</h1>${lead ? `<p class="lead">${lead}</p>` : ''}</div>`;
}

function stageView() {
  return [null, stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8][S.stage]();
}

// ----- Etapa 1 -----
function stage1() {
  const newFiles = S.files.filter(f => f.status === 'extraído' && !S.months.some(m => m.fileId === f.id));
  const canRun = S.consent && aiReady() && newFiles.length;
  return `${head(1, 'Estados de cuenta del mes', 'Carga de uno a doce estados de cuenta mensuales en PDF, con texto o escaneados. El texto se extrae en este navegador y las páginas escaneadas se envían como imagen; con tu autorización, Claude identifica saldos y movimientos y el motor verifica el cuadre.')}
  <section class="panel"><h2>Estados de cuenta (PDF)</h2>
    <div class="drop" id="drop"><strong>Arrastra aquí los PDFs</strong><span>o</span><label class="btn sm" for="pdf-in">Elegir archivos</label><input id="pdf-in" type="file" accept="application/pdf,.pdf" multiple hidden><span class="hint" style="font-size:12px;color:var(--ink-3)">Hasta 12 archivos · 20 MB y 100 páginas cada uno · PDF con texto, escaneado o mixto: las páginas escaneadas se leen como imagen</span></div>
    ${errors.files ? `<div class="status err" role="alert">${esc(errors.files)}</div>` : ''}
    ${S.files.length ? `<ul class="files">${S.files.map(f => `<li><div class="stack"><span class="fn">${esc(f.fileName)}</span><span class="meta">${f.status === 'leyendo' ? `<span class="spinner"></span><span data-reading="${f.id}">Leyendo…</span>` : f.status === 'error' ? `<span style="color:var(--crit)">${esc(f.error)}</span>` : `${f.pages.length} pág.${f.pages.some(p => p.scanned) ? ` (${f.pages.filter(p => p.scanned).length} escaneada${f.pages.filter(p => p.scanned).length === 1 ? '' : 's'}${f.pages.some(p => p.scanned) && !PAGE_IMAGES.has(f.id) ? '; vuelve a cargar el PDF para leerlas' : ''})` : ''} · período ${esc(f.period || 'por identificar')} · ${esc(f.status)}`}</span></div><div class="row">${f.status === 'error' && f._file ? `<button class="btn sm" data-act="retry-file" data-id="${f.id}" ${dis()}>Reintentar</button>` : ''}<button class="btn sm danger" data-act="remove-file" data-id="${f.id}" ${dis(S.closedAt)}>Quitar</button></div></li>`).join('')}</ul>` : ''}
  </section>
  <section class="panel"><h2>Conexión y consentimiento</h2>
    ${AI.mode === 'claude.ai' ? `<p>Esta versión usa Claude a través de tu sesión de claude.ai: no necesitas clave API. La primera llamada pedirá tu permiso; el consumo corresponde a tu cuenta de Claude.</p>` : `<p>Esta versión llama a la API de Anthropic desde el servidor con tu clave cifrada (AES-GCM). El consumo corresponde a esa cuenta API.</p>`}
    <div class="row"><button class="btn" data-act="connect" ${dis()}>${AI.mode === 'claude.ai' ? 'Probar conexión con Claude' : AI.server?.connected ? 'Reemplazar o eliminar clave' : 'Conectar Claude'}</button><span class="conn">${connBadge()}</span></div>
    ${statusFor('connect')}
    <label class="check"><input type="checkbox" id="consent" data-bind-check="consent" ${S.consent ? 'checked' : ''}><span>Autorizo enviar a Claude (Anthropic) el texto extraído de los PDFs y el contexto del condominio para su interpretación. Entiendo que los PDF originales no se guardan en ningún servidor y que el consumo corresponde a ${AI.mode === 'claude.ai' ? 'mi cuenta de Claude' : 'la cuenta API conectada'}.</span></label>
  </section>
  <div class="actionbar">
    <button class="btn primary" data-act="interpret" ${dis(!canRun)}>${S.months.length ? `Interpretar ${newFiles.length} PDF nuevo${newFiles.length === 1 ? '' : 's'}` : 'Interpretar estados de cuenta'}</button>
    ${S.months.length ? `<button class="btn" data-go="2" ${dis()}>Ir a confirmar datos</button>` : ''}
    <label class="btn ghost" for="json-in">Restaurar copia JSON</label><input id="json-in" type="file" accept="application/json,.json" hidden>
    ${statusFor('interpret')}
    ${!canRun && !busy ? `<span class="status">${!S.files.some(f => f.pages?.length) ? 'Carga al menos un PDF.' : !newFiles.length ? 'Todos los PDFs ya están interpretados.' : !aiReady() ? 'Conecta Claude.' : !S.consent ? 'Falta la autorización de envío.' : ''}</span>` : ''}
  </div>
  ${errors.restore ? `<div class="status err" role="alert">${esc(errors.restore)}</div>` : ''}`;
}

// ----- Etapa 2 -----
function stage2() {
  const ms = months();
  const qs = questions();
  const cont = E.continuityChecks(ms);
  const funds = E.computeFunds(ms, S.fundOpenings);
  const pend = pendingTextAnswers();
  const block = blockingOpen();
  const conf = S.confirmation;
  const checks = S._checks || (S._checks = {});
  const allChecked = ['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity'].every(k => checks[k]);
  const catOpts = sel => E.CATEGORIES.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
  return `${head(2, 'Confirmar datos', 'Revisa por mes los saldos y movimientos extraídos, corrige categorías y responde las aclaraciones. Ningún análisis se ejecuta sobre datos sin confirmar.')}
  ${legend()}
  ${confirmed() ? '<div class="banner ok">Datos confirmados. Si cambias algo aquí, deberás confirmar de nuevo y se reiniciará el diagnóstico.</div>' : conf ? '<div class="banner warn">El mapeo cambió después de la última confirmación: revisa y confirma otra vez.</div>' : ''}
  <section class="panel"><h2>Cuenta y período</h2>
    <div class="grid3">
      <label class="f">Moneda<input type="text" id="m-cur" value="MXN" disabled><span class="hint">Sin conversión de moneda.</span></label>
      <label class="f">Banco ${src('pdf')}<input type="text" id="m-bank" data-bind="meta.bank" value="${esc(S.meta.bank)}" placeholder="p. ej. Inbursa"></label>
      <label class="f">Tipo de cuenta ${src('pdf')}<input type="text" id="m-acct" data-bind="meta.accountType" value="${esc(S.meta.accountType)}"></label>
      <div class="kpi"><span class="l">Período cubierto ${src('motor')}</span><span class="v">${esc(ms[0]?.period)} → ${esc(ms.at(-1)?.period)}</span><span class="l">${ms.length} mes${ms.length === 1 ? '' : 'es'}${E.computeIndicators(ms).gaps.length ? ' · con meses faltantes' : ''}</span></div>
    </div>
  </section>
  ${ms.map(m => monthCard(m, catOpts)).join('')}
  ${cont.length ? `<section class="panel"><h2>Continuidad de saldos entre meses ${src('motor')}</h2><div class="tbl-wrap"><table><thead><tr><th>De → a</th><th class="n">Saldo final N</th><th class="n">Saldo inicial N+1</th><th class="n">Diferencia</th><th>Estado</th></tr></thead><tbody>${cont.map(c => `<tr class="${c.ok ? '' : 'flag'}"><td>${c.from} → ${c.to}${c.consecutive ? '' : ' (no consecutivos)'}</td><td class="n">${E.fmtMXN(c.prevFinal)}</td><td class="n">${E.fmtMXN(c.nextInitial)}</td><td class="n">${E.fmtMXN(c.diff)}</td><td>${c.ok ? '<span class="pill ok">Continuo</span>' : c.consecutive ? '<span class="pill bad">Discontinuidad</span>' : '<span class="pill neutral">Meses no consecutivos</span>'}</td></tr>`).join('')}</tbody></table></div></section>` : ''}
  <section class="panel"><h2>Fondos especiales identificados ${src('motor')}</h2>
    ${funds.length ? `<p class="lead">Si el fondo tenía saldo antes del período, indícalo para calcular el fondo comprometido.</p><div class="tbl-wrap"><table><thead><tr><th>Fondo</th><th class="n">Saldo previo ${src('user')}</th><th class="n">Recaudado</th><th class="n">Aplicado</th><th class="n">Saldo</th></tr></thead><tbody>${funds.map((f, i) => `<tr><td>${esc(f.name)}</td><td class="n"><input type="number" step="0.01" id="fund-${i}" data-fund="${esc(f.name)}" value="${esc(S.fundOpenings[f.name] ?? '')}" placeholder="0.00"></td><td class="n">${E.fmtMXN(f.amountCollected)}</td><td class="n">${E.fmtMXN(f.amountPaid)}</td><td class="n">${E.fmtMXN(f.balance)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No se detectaron fondos especiales (impermeabilización, canaletas, reserva, anticipos).</p>'}
  </section>
  <section class="panel" id="questions"><h2>Aclaraciones pendientes (${qs.length})</h2>
    ${qs.length ? qs.map(q => questionView(q, catOpts)).join('') : '<p>No hay preguntas pendientes.</p>'}
  </section>
  <section class="panel"><h2>Confirmación</h2>
    <div class="stack">
      ${[['currency', 'La moneda es MXN.'], ['bank', `El banco (${esc(S.meta.bank || 'sin indicar')}) y el tipo de cuenta son correctos.`], ['period', `El período cubierto (${esc(ms[0]?.period)} → ${esc(ms.at(-1)?.period)}) es correcto.`], ['categories', 'Revisé las categorías asignadas a los movimientos.'], ['funds', 'Los fondos especiales identificados son correctos.'], ['arithmetic', `Revisé el cuadre aritmético de cada mes (${ms.filter(m => !m.balanceCheck).length} con diferencia).`], ['continuity', `Revisé la continuidad de saldos entre meses (${cont.filter(c => !c.ok && c.consecutive).length} discontinuidades).`]].map(([k, t]) => `<label class="check"><input type="checkbox" id="chk-${k}" data-check="${k}" ${checks[k] ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </div>
    ${block.length ? `<div class="banner err" role="alert">Hay ${block.length} pregunta${block.length === 1 ? '' : 's'} bloqueante${block.length === 1 ? '' : 's'} sin resolver. La casilla general no la${block.length === 1 ? '' : 's'} resuelve. <a href="#q-${esc(block[0].id)}" data-scroll="q-${esc(block[0].id)}">Ir a la primera</a></div>` : ''}
    <div class="actionbar">
      ${pend.length ? `<button class="btn primary" data-act="apply-answers" ${dis()}>Aplicar ${pend.length} aclaración${pend.length === 1 ? '' : 'es'} (reinterpretar)</button><span class="status">Las respuestas de texto requieren reinterpretar el mes con Claude; después revisa de nuevo el mapeo.</span>`
        : `<button class="btn primary" data-act="confirm" ${dis(!allChecked || block.length || confirmed())}>${confirmed() ? 'Datos confirmados' : 'Confirmar datos'}</button>${confirmed() ? `<button class="btn" data-go="3">Ir al diagnóstico</button>` : ''}`}
      ${statusFor('interpret')}
    </div>
  </section>`;
}

function monthCard(m, catOpts) {
  const movs = [...m.movements, ...m.unclassifiedMovements].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const file = S.files.find(f => f.id === m.fileId);
  const corr = S.corrections.filter(c => c.period === m.period);
  return `<details class="month" ${m.balanceCheck ? '' : 'open'}><summary>
    <h3>${esc(m.period)}</h3>
    <span class="mini">Saldo inicial ${src('pdf')}<b>${E.fmtMXN(m.initialBalance)}</b></span>
    <span class="mini">Ingresos ${src('motor')}<b>${E.fmtMXN(m.totalIncome)}</b></span>
    <span class="mini">Egresos ${src('motor')}<b>${E.fmtMXN(m.totalExpense)}</b></span>
    <span class="mini">Saldo final ${src('pdf')}<b>${E.fmtMXN(m.finalBalance)}</b></span>
    ${m.balanceCheck ? '<span class="pill ok">Cuadra</span>' : `<span class="pill bad">${m.balanceDiff === null ? 'Cuadre no verificable' : `Diferencia ${E.fmtMXN(m.balanceDiff)}`}</span>`}
    <span class="pill neutral">${movs.length} mov. · ${m.unclassifiedMovements.length} sin categoría</span>
  </summary><div class="body">
    <div class="grid3">
      <label class="f">Saldo inicial ${src('pdf')}<input type="number" step="0.01" id="ini-${m.period}" data-month="${m.period}" data-field="initialBalance" value="${m.initialBalance ?? ''}" placeholder="No identificado"></label>
      <label class="f">Saldo final ${src('pdf')}<input type="number" step="0.01" id="fin-${m.period}" data-month="${m.period}" data-field="finalBalance" value="${m.finalBalance ?? ''}" placeholder="No identificado"></label>
      <div class="kpi"><span class="l">Saldo final esperado ${src('motor')}</span><span class="v">${E.fmtMXN(m.expectedFinal)}</span><span class="l">inicial + ingresos − egresos</span></div>
    </div>
    ${m.reportedIncome !== null || m.reportedExpense !== null ? `<p class="lead" style="font-size:13px">Resumen del estado ${src('pdf')}: depósitos ${E.fmtMXN(m.reportedIncome)} · retiros ${E.fmtMXN(m.reportedExpense)}. Diferencia con movimientos ${src('motor')}: ingresos ${E.fmtMXN(m.incomeVsReported)}, egresos ${E.fmtMXN(m.expenseVsReported)}.</p>` : ''}
    ${notesView(m.notes)}
    <div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Concepto original ${src('pdf')}</th><th>Tipo</th><th class="n">Monto</th><th>Categoría</th><th>Pág.</th></tr></thead><tbody>
    ${movs.map(x => `<tr class="${x.amount === null ? 'flag' : x.category === 'NO_CLASIFICADO' ? 'unc' : ''}" id="mv-${esc(x.id)}"><td class="mono">${esc(x.date)}</td><td title="${esc(x.sourceText)}">${esc(x.concept)}${x.fund ? ` <span class="pill neutral">${esc(x.fund)}</span>` : ''}${x.fromScan ? ' <span class="pill scan" title="Leído de una página escaneada: verifica el importe">Escaneado</span>' : ''}</td><td>${esc(x.type)}</td><td class="n">${x.amount === null ? `<input type="number" step="0.01" min="0" id="amt-${esc(x.id)}" data-amt="${esc(x.id)}" placeholder="No identificado">` : E.fmtMXN(x.amount)}</td><td><select id="cat-${esc(x.id)}" data-cat="${esc(x.id)}" aria-label="Categoría de ${esc(x.concept)}">${catOpts(x.category)}</select>${x.engineSuggestion && x.engineSuggestion !== x.category && x.engineSuggestion !== 'NO_CLASIFICADO' ? `<div style="font-size:11px;color:var(--ink-3)">Motor sugiere: ${esc(E.catLabel(x.engineSuggestion))}</div>` : ''}</td><td class="mono">${x.sourcePageNumber ?? '—'}</td></tr>`).join('')}
    </tbody></table></div>
    ${corr.length ? `<div class="stack"><strong style="font-size:13px">Correcciones documentadas ${src('user')}</strong>${corr.map(c => `<span style="font-size:13px;color:var(--ink-2)">${esc(new Date(c.at).toLocaleString('es-MX'))} · ${esc(c.what)}${c.why ? ` — «${esc(c.why)}»` : ''}</span>`).join('')}</div>` : ''}
    <p style="font-size:12px;color:var(--ink-3)">Archivo: ${esc(file?.fileName || '—')}</p>
  </div></details>`;
}

// Observaciones de Claude agrupadas por tipo, con cifras resaltadas.
const hlAmounts = s => esc(s).replace(/(-?\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\b\d{1,3}(?:,\d{3})+(?:\.\d{2})?\b|\b\d+\.\d{2}\b)/g, '<span class="amt">$1</span>');
function notesView(raw) {
  const notes = (raw || []).map(E.normalizeNote).filter(n => n.detail);
  if (!notes.length) return '';
  const groups = Object.entries(E.NOTE_KINDS).sort((a, b) => a[1].order - b[1].order).map(([k, v]) => [k, v, notes.filter(n => n.kind === k)]).filter(g => g[2].length);
  const count = k => notes.filter(n => n.kind === k).length;
  return `<details class="notes" ${count('inconsistencia') ? 'open' : ''}><summary><span class="notes-t">Observaciones de Claude sobre la lectura ${src('ia')}</span><span class="notes-c">${groups.map(([k, v, g]) => `<span class="nk ${k}">${g.length} ${g.length === 1 ? v.one : v.many}</span>`).join('')}</span></summary>
    <div class="notes-b">${groups.map(([k, v, g]) => `<section class="ng ${k}"><h4>${esc(v.label)}</h4><ul>${g.map(n => `<li>${n.title ? `<strong>${esc(n.title)}</strong>` : ''}<p>${hlAmounts(n.detail)}</p></li>`).join('')}</ul></section>`).join('')}</div></details>`;
}

function questionView(q, catOpts) {
  const mv = q.movementId ? allMovements().find(m => m.id === q.movementId) : null;
  let input = '';
  if (q.kind === 'category') input = `<select id="qa-${esc(q.id)}" data-qcat="${esc(q.movementId)}"><option value="">Elegir categoría…</option>${catOpts('')}</select>`;
  else if (q.kind === 'amount') input = `<input type="number" step="0.01" min="0" id="qa-${esc(q.id)}" data-qamt="${esc(q.movementId)}" placeholder="Monto en MXN">`;
  else if (q.kind === 'balance') input = `<input type="number" step="0.01" id="qa-${esc(q.id)}" data-qbal="${esc(q.period)}|${esc(q.field)}" placeholder="Monto en MXN">`;
  else input = `<textarea id="qa-${esc(q.id)}" data-qtext="${esc(q.id)}" placeholder="Tu respuesta">${esc(S.answers[q.id] || '')}</textarea>`;
  return `<div class="q ${q.blocking ? 'blocking' : ''}" id="q-${esc(q.id)}"><div class="row">${q.blocking ? '<span class="pill critical">Bloqueante</span>' : '<span class="pill neutral">Informativa</span>'}<span class="pill neutral">${esc(q.period)}</span>${q.kind === 'text' ? src('ia') : src('motor')}</div><p>${esc(q.prompt)}</p>${mv ? `<p style="font-size:13px;color:var(--ink-2)">Movimiento: ${esc(mv.date)} · ${esc(mv.concept)} · ${E.fmtMXN(mv.amount)} · <a href="#mv-${esc(mv.id)}" data-scroll="mv-${esc(mv.id)}">ver en la tabla</a></p>` : ''}${input}</div>`;
}

// ----- Etapa 3 -----
function stage3() {
  const ind = S.diagnosis?.indicators || indicators();
  const an = S.diagnosis?.anomalies || E.detectAnomalies(months(), ind);
  const ai = S.diagnosis?.ai;
  const stale = S.diagnosis && S.diagnosis.hash !== mappingHash();
  return `${head(3, 'Diagnóstico', 'El motor calcula flujo, variaciones, composición de egresos, fondos comprometidos y recaudación; Claude interpreta esos resultados y propone hallazgos.')}
  ${legend()}
  ${stale ? '<div class="banner warn">Los datos cambiaron desde este diagnóstico. Genera uno nuevo.</div>' : ''}
  ${ind.gaps.length ? `<div class="banner warn">Comparabilidad limitada: faltan meses entre ${esc(ind.periodFrom)} y ${esc(ind.periodTo)} (${ind.gaps.map(esc).join(', ')}).</div>` : ''}
  <section class="panel"><h2>Indicadores ${src('motor')}</h2>${kpiGrid(ind)}</section>
  <section class="panel"><h2>Flujo mensual consolidado ${src('motor')}</h2>${flowTable(ind)}</section>
  <section class="panel"><h2>Evolución del saldo bancario ${src('pdf')}</h2>${svgBalance(ind.months, { accent: '#a5532a' })}</section>
  <section class="panel"><h2>Composición de egresos del período ${src('motor')}</h2>${svgComposition(ind.composition, { accent: '#a5532a' })}</section>
  <section class="panel"><h2>Indicadores de alerta</h2>
    <div class="grid3">
      <div class="kpi"><span class="l">Morosidad conocida</span><span class="v">${ind.delinquentDebt === null ? 'Sin datos' : E.fmtMXN(ind.delinquentDebt)}</span></div>
      <div class="kpi"><span class="l">Gastos atípicos (reglas)</span><span class="v">${an.filter(a => ['unusual_expense', 'potential_duplicate'].includes(a.kind)).length}</span></div>
      <div class="kpi"><span class="l">Saldo comprometido</span><span class="v">${ind.committedPct === null ? '—' : ind.committedPct + '%'}</span></div>
    </div>
    <h3>Reglas disparadas por el motor (${an.length}) ${src('motor')}</h3>
    ${an.length ? `<div class="tbl-wrap"><table><thead><tr><th>Id</th><th>Nivel</th><th>Regla</th><th>Detalle</th></tr></thead><tbody>${an.map(a => `<tr><td class="mono">${a.id}</td><td><span class="pill ${a.level}">${E.LEVEL_LABEL[a.level]}</span></td><td>${esc(a.title)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Ninguna regla de anomalía se disparó con los datos confirmados.</p>'}
  </section>
  ${ai ? `<section class="panel"><h2>Resumen ejecutivo ${src('ia')}</h2><p>${esc(ai.executiveSummary)}</p>${(ai.trends || []).length ? `<h3>Tendencias</h3><ul>${ai.trends.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${ai.comparabilityNote ? `<p class="lead">${esc(ai.comparabilityNote)}</p>` : ''}</section>
  <section class="panel"><h2>Hallazgos propuestos (${ai.findings.length}) ${src('ia')}</h2>${ai.findings.map(f => findingCard(f)).join('')}</section>` : ''}
  <div class="actionbar">
    <button class="btn ${ai ? '' : 'primary'}" data-act="analyze" ${dis()}>${ai ? 'Regenerar diagnóstico' : 'Generar diagnóstico con Claude'}</button>
    <button class="btn ghost" data-go="2" ${dis()}>Volver a confirmar datos</button>
    ${ai && !stale ? '<button class="btn primary" data-go="4">Continuar a hallazgos</button>' : ''}
    ${statusFor('analyze')}
  </div>`;
}

function findingCard(f, { selectable = false, selected = false } = {}) {
  const mv = new Map(allMovements().map(m => [m.id, m]));
  return `<article class="finding ${esc(f.level)} ${selected ? 'sel' : ''}"><div class="hd"><span class="pill ${esc(f.level)}">${E.LEVEL_LABEL[f.level]}</span><h3>${esc(f.title)}</h3><span class="mono" style="font-size:12px;color:var(--ink-3)">${esc(f.id)} · ${esc(E.catLabel(f.category))} · ${esc(f.kind || '')}</span></div>
  <p>${esc(f.description)}</p>
  <div class="ev"><b>Evidencia ${src('pdf')}</b><ul>${(f.evidence || []).map(id => mv.get(id)).filter(Boolean).map(m => `<li class="mono" style="font-size:12.5px">${esc(m.date)} · ${esc(m.concept)} · ${E.fmtMXN(m.amount)} (${esc(m.type)})</li>`).join('')}</ul></div>
  ${f.impact ? `<p class="ev"><b>Impacto posible:</b> ${esc(f.impact)}</p>` : ''}
  <p class="ev"><b>Acción recomendada:</b> ${esc(f.recommendation || 'Sin recomendación cuantificada por datos insuficientes.')}</p>
  ${f.missingData ? `<p class="ev"><b>Datos para confirmar:</b> ${esc(f.missingData)}</p>` : ''}
  ${selectable ? `<div class="row"><button class="btn sm ${selected ? '' : 'primary'}" data-act="toggle-sel" data-id="${esc(f.id)}" ${dis(!selected && S.selection.length >= 3)}>${selected ? 'Quitar de la selección' : 'Seleccionar'}</button></div>` : ''}
  </article>`;
}

// ----- Etapa 4 -----
function stage4() {
  const props = S.diagnosis.ai.findings;
  const sel = S.selection;
  return `${head(4, 'Hallazgos prioritarios', 'Elige exactamente tres hallazgos, ordénalos por urgencia (1 = más urgente) y ajusta su nivel si lo consideras necesario. La selección es tuya: nada viene preseleccionado.')}
  <section class="panel"><h2>Tu selección (${sel.length}/3) ${src('user')}</h2>
    ${sel.length ? `<ol class="order">${sel.map((s, i) => { const p = props.find(f => f.id === s.id); const hy = p.hypotheses || []; return `<li><span class="rk">${i + 1}</span><div class="stack"><strong>${esc(p.title)}</strong><div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Nivel <select id="lvl-${esc(s.id)}" data-level="${esc(s.id)}" style="width:auto">${E.LEVELS.map(l => `<option value="${l}" ${l === s.level ? 'selected' : ''}>${E.LEVEL_LABEL[l]}</option>`).join('')}</select></label>${s.level !== p.level ? `<span class="pill neutral">IA proponía ${E.LEVEL_LABEL[p.level]}</span>` : ''}</div>${hy.length ? `<div class="stack">${hy.map((h, k) => `<label class="check" style="font-size:13px"><input type="checkbox" id="hy-${esc(s.id)}-${k}" data-hyp="${esc(s.id)}|${k}" ${(s.acceptedHypotheses || []).includes(k) ? 'checked' : ''} ${h.quantified ? '' : 'disabled'}><span>Hipótesis: ${esc(h.text)} ${h.quantified ? '' : '<em style="color:var(--ink-3)">(no cuantificada; no se puede aceptar)</em>'}</span></label>`).join('')}</div>` : ''}</div><div class="row"><button class="btn sm" data-act="up" data-i="${i}" aria-label="Subir" ${dis(i === 0)}>↑</button><button class="btn sm" data-act="down" data-i="${i}" aria-label="Bajar" ${dis(i === sel.length - 1)}>↓</button></div></li>`; }).join('')}</ol>` : '<p>Aún no seleccionas hallazgos.</p>'}
    <div class="actionbar"><button class="btn primary" data-act="confirm-sel" ${dis(sel.length !== 3 || S.selectionConfirmedAt)}>${S.selectionConfirmedAt ? 'Selección confirmada' : 'Confirmar los tres hallazgos'}</button>${S.selectionConfirmedAt ? '<button class="btn" data-go="5">Ir al reporte</button>' : ''}${sel.length !== 3 ? `<span class="status">Selecciona ${3 - sel.length > 0 ? `${3 - sel.length} más` : 'solo tres'}.</span>` : ''}</div>
  </section>
  <section class="panel"><h2>Hallazgos propuestos ${src('ia')}</h2>${props.map(f => findingCard(f, { selectable: true, selected: sel.some(s => s.id === f.id) })).join('')}</section>`;
}

// ----- Etapa 5 -----
function stage5() {
  const r = S.report;
  return `${head(5, 'Reporte ejecutivo', 'Claude redacta el contenido con los tres hallazgos confirmados; las tablas, gráficos, fondos y morosidad provienen del motor.')}
  <section class="panel"><h2>Observaciones del revisor ${src('user')}</h2>
    <label class="f">Indicaciones para la redacción (opcional)<textarea id="obs" data-bind="observationsDraft" placeholder="p. ej. Enfatizar el avance de impermeabilización del edificio 2; aclarar que el pago de marzo corresponde a dos meses.">${esc(S.observationsDraft)}</textarea></label>
    ${r && (S.observationsDraft || '') !== (r.observations || '') ? '<div class="banner warn">Las observaciones cambiaron: regenera el reporte para incorporarlas. Se invalidó la aprobación y la nota.</div>' : ''}
    <div class="actionbar"><button class="btn ${r ? '' : 'primary'}" data-act="report" ${dis()}>${r ? 'Regenerar reporte' : 'Generar reporte'}</button>${r && (S.observationsDraft || '') === (r.observations || '') ? '<button class="btn primary" data-go="6">Pasar a verificación</button>' : ''}${statusFor('report')}</div>
  </section>
  ${r ? `<section class="panel"><div class="row"><h2>Vista previa</h2><span class="pill moderate">Borrador para revisión</span></div>${previewFrame()}</section>` : ''}`;
}

function previewFrame() {
  return `<iframe class="doc" id="preview" title="Vista previa del reporte" style="width:100%;border:0;min-height:600px;padding:0" sandbox="allow-same-origin"></iframe>`;
}

// ----- Etapa 6 -----
function stage6() {
  const rv = S.review;
  const d = S._review || (S._review = { reviewer: '', role: 'Miembro del Comité de Vigilancia', a: false, b: false, c: false });
  const ok = d.reviewer.trim() && d.a && d.b && d.c;
  return `${head(6, 'Verificación humana', 'Revisa el reporte completo y confirma expresamente cada criterio. La aprobación es tuya: la IA no puede otorgarla.')}
  <section class="panel">${previewFrame()}</section>
  <section class="panel"><h2>Criterios de revisión</h2>
    ${rv?.approvedAt ? `<div class="banner ok">Aprobado por ${esc(rv.reviewer)} (${esc(rv.role)}) el ${esc(new Date(rv.approvedAt).toLocaleString('es-MX'))}.</div>` : `
    <label class="check"><input type="checkbox" id="rv-a" data-rv="a" ${d.a ? 'checked' : ''}><span>(a) Verifiqué las cifras y el cuadre aritmético contra los estados de cuenta.</span></label>
    <label class="check"><input type="checkbox" id="rv-b" data-rv="b" ${d.b ? 'checked' : ''}><span>(b) Verifiqué la evidencia de cada hallazgo frente a los movimientos.</span></label>
    <label class="check"><input type="checkbox" id="rv-c" data-rv="c" ${d.c ? 'checked' : ''}><span>(c) Las recomendaciones son coherentes con la situación del condominio.</span></label>
    <div class="grid2"><label class="f">Nombre del revisor<input type="text" id="rv-name" data-rvname="1" value="${esc(d.reviewer)}" maxlength="120"></label>
    <label class="f">Función<select id="rv-role" data-rvrole="1">${['Administrador', 'Miembro del Comité de Vigilancia', 'Condómino revisor'].map(o => `<option ${o === d.role ? 'selected' : ''}>${o}</option>`).join('')}</select></label></div>
    <p style="font-size:12.5px;color:var(--ink-3)">Esta aprobación queda registrada con fecha y hora. No es firma electrónica ni acta de Asamblea.</p>`}
    <div class="actionbar">
      ${rv?.approvedAt ? (S.alert ? '<button class="btn primary" data-go="7">Ver nota de alerta</button>' : `<button class="btn primary" data-act="alert" ${dis()}>Generar nota de alerta</button>`) : `<button class="btn primary" data-act="approve" ${dis(!ok)}>Aprobar reporte</button>`}
      <button class="btn ghost" data-go="5" ${dis()}>Volver al reporte para pedir ajustes</button>
      ${statusFor('alert')}
      ${!rv?.approvedAt && !ok ? `<span class="status">${!d.reviewer.trim() ? 'Falta el nombre del revisor.' : 'Faltan confirmaciones.'}</span>` : ''}
    </div>
  </section>`;
}

// ----- Etapa 7 -----
function stage7() {
  const a = S.alert;
  return `${head(7, 'Nota de alerta para el Comité de Vigilancia', 'Comprueba que la nota sea coherente con el reporte aprobado. Es un instrumento de apoyo interno: no se envía a nadie automáticamente.')}
  ${a ? `<section class="panel doc-lite"><div class="doc" style="padding:22px">${alertBody(a.ai, S).replace('<h2>', '<h2 style="color:#0b1628">')}</div></section>` : `<section class="panel"><p>La nota aún no se ha generado.</p></section>`}
  <div class="actionbar">
    ${a ? (a.acceptedAt ? `<span class="pill ok">Nota aceptada ${esc(new Date(a.acceptedAt).toLocaleString('es-MX'))}</span><button class="btn primary" data-go="8">Ir a entrega</button>` : `<button class="btn primary" data-act="accept-alert" ${dis()}>Aceptar nota</button>`) : ''}
    <button class="btn" data-act="alert" ${dis()}>${a ? 'Regenerar nota' : 'Generar nota'}</button>
    <button class="btn ghost" data-go="5" ${dis()}>Regresar a corregir el reporte</button>
    ${statusFor('alert')}
  </div>`;
}

// ----- Etapa 8 -----
function stage8() {
  return `${head(8, 'Entrega', 'Descarga el reporte ejecutivo (HTML con gráficos, imprimible a PDF) y la copia JSON del avance. Cierra el análisis cuando hayas revisado los entregables.')}
  <section class="panel"><h2>Entregables</h2>
    <div class="row">
      <button class="btn primary" data-act="dl-html" ${dis()}>Descargar reporte HTML</button>
      <button class="btn" data-act="dl-json" ${dis()}>Descargar copia JSON</button>
    </div>
    <p style="font-size:13px;color:var(--ink-2)">Para imprimir o guardar como PDF, abre el HTML descargado y usa el botón «Imprimir / Guardar PDF». La copia JSON contiene datos extraídos, mapeo, decisiones y avance, sin credenciales.</p>
    ${errors.download ? `<div class="status err">${esc(errors.download)}</div>` : ''}
  </section>
  <section class="panel">${previewFrame()}</section>
  <section class="panel"><h2>Cierre</h2>
    ${S.closedAt ? `<div class="banner ok">Análisis cerrado el ${esc(new Date(S.closedAt).toLocaleString('es-MX'))}.</div>` : '<p>Al cerrar se registra el evento. Seguirás pudiendo consultar y descargar.</p>'}
    <div class="actionbar">
      ${S.closedAt ? '' : `<button class="btn primary" data-act="close" ${dis()}>Cerrar análisis</button>`}
      <button class="btn danger" data-act="new" ${dis()}>Nuevo análisis</button>
    </div>
    ${S._confirmNew ? `<div class="banner err" role="alertdialog"><div class="stack"><strong>¿Borrar el caso local?</strong><span>Se eliminará de este navegador el análisis de ${esc(S.condo.name)}. Descarga antes la copia JSON si la necesitas. La conexión con Claude se conserva.</span><div class="row"><button class="btn danger" data-act="new-yes">Sí, borrar e iniciar</button><button class="btn" data-act="new-no">Cancelar</button></div></div></div>` : ''}
  </section>`;
}

function logView() {
  return `<details class="log"><summary>Registro de actividad (${S.events.length} eventos · ${S.calls.length} llamadas a Claude)</summary><div class="inner">
  <div class="tbl-wrap"><table><thead><tr><th>Fecha y hora</th><th>Evento</th><th>Detalle</th></tr></thead><tbody>${S.events.slice().reverse().slice(0, 200).map(e => `<tr><td class="mono">${esc(new Date(e.at).toLocaleString('es-MX'))}</td><td>${esc(e.type)}</td><td>${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>
  ${S.calls.length ? `<div class="tbl-wrap"><table><thead><tr><th>Momento</th><th>Acción</th><th>Modelo</th><th class="n">Tokens entrada</th><th class="n">Tokens salida</th></tr></thead><tbody>${S.calls.slice().reverse().map(c => `<tr><td class="mono">${esc(new Date(c.at).toLocaleString('es-MX'))}</td><td>${esc(c.action)}</td><td>${esc(c.model)}</td><td class="n">${c.inputTokens ?? `≈${Math.round(c.approxInputChars / 4).toLocaleString('es-MX')}*`}</td><td class="n">${c.outputTokens ?? `≈${Math.round(c.approxOutputChars / 4).toLocaleString('es-MX')}*`}</td></tr>`).join('')}</tbody></table></div><p style="font-size:12px;color:var(--ink-3)">* Estimado (caracteres ÷ 4): claude.ai no informa tokens a la página.</p>` : ''}
  <div class="row"><button class="btn sm" data-act="dl-json" ${dis()}>Descargar copia JSON</button></div>
  </div></details>`;
}

// ---------- Eventos ----------
function setPath(path, val) { const [a, b] = path.split('.'); if (b) S[a][b] = val; else S[a] = val; }

function wireAfterRender() {
  const fr = document.getElementById('preview');
  if (fr && S.report) {
    fr.srcdoc = standaloneReport(S, indicators(), { preview: true, logo: LOGO });
    fr.onload = () => { try { fr.style.height = (fr.contentDocument.documentElement.scrollHeight + 20) + 'px'; } catch {} };
  }
  const drop = document.getElementById('drop');
  if (drop) {
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (!busy && !S.closedAt) addFiles(e.dataTransfer.files); };
  }
}

document.addEventListener('click', async e => {
  const t = e.target.closest('[data-go],[data-act],[data-scroll]');
  if (!t || t.disabled) return;
  if (t.dataset.scroll) { e.preventDefault(); const el = document.getElementById(t.dataset.scroll); el?.closest('details')?.setAttribute('open', ''); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); el?.querySelector('input,select,textarea')?.focus(); return; }
  if (t.dataset.go) return go(Number(t.dataset.go));
  const act = t.dataset.act;
  if (busy && !['new-no'].includes(act)) return;
  switch (act) {
    case 'connect': return testConnection();
    case 'remove-file': {
      const f = S.files.find(x => x.id === t.dataset.id);
      S.files = S.files.filter(x => x.id !== t.dataset.id);
      PAGE_IMAGES.delete(t.dataset.id);
      if (S.months.some(m => m.fileId === t.dataset.id)) { S.months = S.months.filter(m => m.fileId !== t.dataset.id); invalidate('mapping'); }
      log('pdf_quitado', f?.fileName); save(); return render();
    }
    case 'retry-file': {
      const f = S.files.find(x => x.id === t.dataset.id);
      PAGE_IMAGES.delete(t.dataset.id);
      if (f?._file) { S.files = S.files.filter(x => x !== f); return addFiles([f._file]); }
      return;
    }
    case 'interpret': { const ok = await runInterpret(); if (ok && S.months.length) go(2); return; }
    case 'apply-answers': {
      const ids = [...new Set(pendingTextAnswers().map(q => S.months.find(m => m.period === q.period)?.fileId).filter(Boolean))];
      log('aclaraciones', `Aplicando ${pendingTextAnswers().length} respuestas`);
      await runInterpret(ids); S._checks = {}; save(); return render();
    }
    case 'confirm': {
      if (blockingOpen().length) return;
      S.confirmation = { at: now(), hash: mappingHash(), currency: 'MXN', bank: S.meta.bank, period: `${months()[0]?.period}..${months().at(-1)?.period}`, checks: { ...S._checks } };
      log('confirmación', `Datos confirmados (${S.months.length} meses)`); save(); return render();
    }
    case 'analyze': return runAnalyze();
    case 'toggle-sel': {
      const id = t.dataset.id;
      const i = S.selection.findIndex(s => s.id === id);
      if (i >= 0) S.selection.splice(i, 1);
      else if (S.selection.length < 3) { const p = S.diagnosis.ai.findings.find(f => f.id === id); S.selection.push({ id, level: p.level, acceptedHypotheses: [] }); }
      if (S.selectionConfirmedAt || S.report) invalidate('selection');
      log('selección', S.selection.map(s => s.id).join(', ') || '(vacía)'); save(); return render();
    }
    case 'up': case 'down': {
      const i = Number(t.dataset.i), j = act === 'up' ? i - 1 : i + 1;
      [S.selection[i], S.selection[j]] = [S.selection[j], S.selection[i]];
      if (S.selectionConfirmedAt || S.report) invalidate('selection');
      log('orden', S.selection.map(s => s.id).join(' > ')); save(); return render();
    }
    case 'confirm-sel': S.selectionConfirmedAt = now(); log('selección_confirmada', S.selection.map(s => `${s.id}:${s.level}`).join(', ')); save(); return render();
    case 'report': return runReport();
    case 'approve': {
      const d = S._review;
      if (!(d.reviewer.trim() && d.a && d.b && d.c)) return;
      S.review = { reviewer: d.reviewer.trim(), role: d.role, checks: { a: true, b: true, c: true }, approvedAt: now() };
      log('aprobación', `${S.review.reviewer} (${S.review.role})`); save(); render();
      await runAlert();
      if (S.alert) go(7);
      return;
    }
    case 'alert': { invalidate('alert'); save(); await runAlert(); if (S.alert && S.stage !== 7) go(7); return; }
    case 'accept-alert': S.alert.acceptedAt = now(); log('nota_aceptada', ''); save(); return render();
    case 'dl-html': return download(`reporte-${slug(S.condo.name)}-${indicators().periodTo}.html`, standaloneReport(S, indicators(), { logo: LOGO }), 'text/html');
    case 'dl-json': return download(`analisis-${slug(S.condo.name)}-${new Date().toISOString().slice(0, 10)}.json`, exportJSON(), 'application/json');
    case 'close': S.closedAt = now(); log('cierre', 'Análisis cerrado por el usuario'); save(); return render();
    case 'new': S._confirmNew = true; return render();
    case 'new-no': S._confirmNew = false; return render();
    case 'new-yes': { try { localStorage.removeItem(STORE_KEY); } catch {} S = fresh(); log('nuevo_análisis', ''); save(); return render(); }
  }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind) {
    setPath(t.dataset.bind, t.value);
    if (t.dataset.bind === 'observationsDraft' && S.report && (S.review || S.alert)) { invalidate('review'); }
    save();
  }
  if (t.dataset.qtext) { S.answers[t.dataset.qtext] = t.value; save(); }
  if (t.dataset.rvname) { S._review.reviewer = t.value; save(); const b = document.querySelector('[data-act="approve"]'); if (b) b.disabled = !(t.value.trim() && S._review.a && S._review.b && S._review.c); }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'pdf-in' && t.files.length) { addFiles(t.files); t.value = ''; return; }
  if (t.id === 'json-in' && t.files[0]) {
    t.files[0].text().then(restoreJSON).then(() => { errors.restore = null; }).catch(err => { errors.restore = err.message; render(); });
    t.value = ''; return;
  }
  if (t.dataset.bindCheck) { S[t.dataset.bindCheck] = t.checked; log(t.dataset.bindCheck, t.checked ? 'otorgado' : 'retirado'); save(); return render(); }
  if (t.dataset.bind === 'observationsDraft' || t.dataset.bind?.startsWith('meta.')) { if (t.dataset.bind.startsWith('meta.') && confirmed()) { S.confirmation = null; invalidate('confirmation'); } save(); return render(); }
  if (t.dataset.bind) return render();
  if (t.dataset.check) { S._checks[t.dataset.check] = t.checked; save(); return render(); }
  if (t.dataset.cat) return changeMovement(t.dataset.cat, { category: t.value }, true);
  if (t.dataset.qcat && t.value) return changeMovement(t.dataset.qcat, { category: t.value }, false, 'Respuesta a aclaración');
  if ((t.dataset.amt || t.dataset.qamt) && t.value !== '') return changeMovement(t.dataset.amt || t.dataset.qamt, { amount: Math.abs(Number(t.value)) }, false, 'Monto no identificado capturado por el usuario');
  if (t.dataset.qbal && t.value !== '') { const [p, f] = t.dataset.qbal.split('|'); return changeBalance(p, f, t.value); }
  if (t.dataset.month) return changeBalance(t.dataset.month, t.dataset.field, t.value);
  if (t.dataset.fund !== undefined) { S.fundOpenings[t.dataset.fund] = t.value === '' ? undefined : Number(t.value); if (confirmed()) invalidate('confirmation'); S.confirmation = null; log('fondo', `${t.dataset.fund}: saldo previo ${t.value || 'vacío'}`); save(); return render(); }
  if (t.dataset.level) { const s = S.selection.find(x => x.id === t.dataset.level); s.level = t.value; if (S.selectionConfirmedAt || S.report) invalidate('selection'); log('nivel', `${s.id} → ${t.value}`); save(); return render(); }
  if (t.dataset.hyp) { const [id, k] = t.dataset.hyp.split('|'); const s = S.selection.find(x => x.id === id); const n = Number(k); s.acceptedHypotheses = t.checked ? [...new Set([...(s.acceptedHypotheses || []), n])] : (s.acceptedHypotheses || []).filter(x => x !== n); if (S.report) invalidate('report'); log('hipótesis', `${id}#${k} ${t.checked ? 'aceptada' : 'retirada'}`); save(); return render(); }
  if (t.dataset.rv) { S._review[t.dataset.rv] = t.checked; save(); return render(); }
  if (t.dataset.rvrole) { S._review.role = t.value; save(); }
});

let pendingWhy = null;
function changeMovement(id, patch, askWhy, why = '') {
  for (const m of S.months) for (const list of ['movements', 'unclassifiedMovements']) {
    const mv = m[list].find(x => x.id === id);
    if (!mv) continue;
    const before = { category: mv.category, amount: mv.amount };
    Object.assign(mv, patch);
    const what = patch.category ? `${mv.date} «${mv.concept}»: ${E.catLabel(before.category)} → ${E.catLabel(patch.category)}` : `${mv.date} «${mv.concept}»: monto ${E.fmtMXN(patch.amount)}`;
    const entry = { at: now(), period: m.period, movementId: id, what, why };
    S.corrections.push(entry);
    Object.assign(m, E.recomputeMonth(m));
    invalidate('confirmation'); S.confirmation = null;
    log('corrección', what);
    save(); render();
    if (askWhy) askExplanation(entry);
    return;
  }
}
function changeBalance(period, field, value) {
  const m = S.months.find(x => x.period === period);
  if (!m) return;
  const v = value === '' ? null : Number(value);
  S.corrections.push({ at: now(), period, what: `${field === 'initialBalance' ? 'Saldo inicial' : 'Saldo final'} ${period}: ${E.fmtMXN(m[field])} → ${E.fmtMXN(v)}`, why: 'Capturado por el usuario' });
  m[field] = v; Object.assign(m, E.recomputeMonth(m));
  invalidate('confirmation'); S.confirmation = null;
  log('corrección', `${field} ${period}`); save(); render();
}
function askExplanation(entry) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="ex-t"><h2 id="ex-t">Explica la corrección</h2><p class="lead">${esc(entry.what)}</p><label class="f">Motivo (queda en el registro y en la copia JSON)<textarea id="ex-why" placeholder="p. ej. La factura del proveedor indica que es servicio de jardinería."></textarea></label><div class="row"><button class="btn primary" id="ex-ok">Guardar explicación</button><button class="btn ghost" id="ex-skip">Omitir</button></div></div>`;
  document.body.append(bg);
  $('#ex-why').focus();
  $('#ex-ok').onclick = () => { entry.why = $('#ex-why').value.trim(); save(); bg.remove(); render(); };
  $('#ex-skip').onclick = () => bg.remove();
}

render();
initAI();
