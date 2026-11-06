// Interfaz y orquestación del workflow de 8 etapas.
import * as E from '../lib/condominio.mjs';
import { buildPrompt, parseJsonText, validateResult } from '../lib/ai.mjs';
import { itemsToLines, checkFileLimits, detectPeriod, PDF_MAX_PAGES, MAX_FILES } from '../lib/pdf-parser.mjs';
import { esc, svgBalance, svgComposition, flowTable, fundsTable, fundRows, kpiGrid, standaloneReport, alertBody, alertPlainText } from './report.mjs';

const STORE_KEY = 'hampton-analisis-v1';
const SCHEMA = 'condominio-analisis-estados-cuenta';
const TIMEOUT_MS = { interpret: 300000, origins: 180000, analyze: 180000, report: 180000, alert: 180000, test: 60000 };
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
    role: 'condomino', qActions: {},
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
    return { ...fresh(), ...s, condo: { ...CONDO }, _confirmNew: false };
  } catch { storageOk = false; return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); storageOk = true; }
  catch { storageOk = false; }
}
// Casos guardados con versiones anteriores: unifica nombres de fondo y deduce el origen.
function migrate(st) {
  for (const m of st.months || []) for (const list of ['movements', 'unclassifiedMovements']) for (const mv of m[list] || []) {
    mv.fund = mv.fundManual ? (E.normalizeFund(mv.fund) || E.FUND_NONE) : (mv.fund === E.FUND_NONE ? E.defaultFund(mv.category, mv.concept) : E.resolveFund(mv.fund, mv.category, mv.concept));
    if (mv.origin === undefined) mv.origin = (mv.type === 'abono' || /REEMBOLSO|DEVOLUCION|REINTEGRO/.test(E.normText(mv.concept))) ? E.extractOrigin(`${mv.concept || ''} ${mv.sourceText || ''}`) : '';
  }
  const fo = {};
  for (const [k, v] of Object.entries(st.fundOpenings || {})) if (v !== undefined && v !== null && v !== '') fo[E.normalizeFund(k) || k] = v;
  st.fundOpenings = fo;
  return st;
}
let S = migrate(load() || fresh());
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
  return [...eq, ...aiq].filter(q => !isHandled(q));
}
// Una aclaración queda atendida si se envió como observación o se marcó como no relevante
// (se compara el texto: al releer un mes, una pregunta nueva puede reusar el mismo id).
const isHandled = q => { const a = S.qActions?.[q.id]; return !!a && (a.prompt === q.prompt || q.kind !== 'text'); };
function observations() {
  return Object.entries(S.qActions || {}).filter(([, a]) => a.action === 'observation').map(([qid, a]) => ({ qid, ...a })).sort((a, b) => String(a.period).localeCompare(String(b.period)) || String(a.at).localeCompare(String(b.at)));
}
const dismissed = () => Object.entries(S.qActions || {}).filter(([, a]) => a.action === 'dismiss');
const R = () => E.roleOf(S.role);
const answerOpen = new Set();
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
const scrollMainTop = () => { const m = document.querySelector('main'); if (m) m.scrollTop = 0; };
function go(n) { if (!enabled(n)) return; S.stage = n; save(); render(); scrollMainTop(); }
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

// Operación en curso. Puede tener varias llamadas a Claude simultáneas (busy.calls) y,
// al interpretar, el avance por archivo (busy.files).
let busy = null; // {key, startedAt, msg, calls: Map, files?: []}
let callSeq = 0;
const INTERPRET_CONCURRENCY = 3; // llamadas simultáneas a Claude al interpretar
async function runPool(tasks, n) {
  let next = 0;
  const worker = async () => { while (next < tasks.length) { const t = tasks[next++]; await t(); } };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
}
function startBusy(key, extra = {}) { busy = { key, startedAt: Date.now(), msg: '', calls: new Map(), ...extra }; tick = setInterval(updateBusy, 8000); render(); }
function endBusy() { clearInterval(tick); busy = null; }
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
    truncated: 'La respuesta de Claude superó su límite de longitud y se descartó para no guardar datos incompletos. Reintenta.',
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
  const owner = !busy;
  if (owner) startBusy(key);
  const callId = ++callSeq;
  const prog = { label, msg: 'iniciando…', chars: 0, startedAt: Date.now() };
  busy.calls.set(callId, prog);
  updateBusy();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS[op] || 180000);
  const started = now();
  try {
    let text, usage = null, model = AI.model;
    if (AI.mode === 'claude.ai') {
      try {
        const res = await AI.sample(`${system}\n\n${user}`, {
          modelTier: op === 'interpret' ? 'default' : 'complex', cache: false, signal: ctl.signal,
          ...(images.length ? { images } : {}),
          onText: ({ text }) => { prog.chars = text.length; prog.msg = 'recibiendo respuesta…'; updateBusy(); },
        });
        if (res.truncated) { const e = new Error('truncated'); e.code = 'truncated'; throw e; }
        text = res.text;
        model = res.modelApplied || model;
      } catch (e) {
        if (e?.code === 'cancelled' && timedOut) { const t = new Error('timeout'); t.code = 'timeout'; throw t; }
        throw e;
      }
    } else {
      ({ text, usage, model } = await serverAI(op, payload, ctl.signal, images, j => { prog.msg = j.message || prog.msg; prog.chars = j.chars ?? prog.chars; updateBusy(); }, () => timedOut));
    }
    const parsed = parseJsonText(text);
    const result = validateResult(op, parsed, payload);
    S.calls.push({ action: op + (images.length ? ` (+${images.length} imágenes)` : ''), model, at: started, finishedAt: now(), inputTokens: usage?.input_tokens ?? null, outputTokens: usage?.output_tokens ?? null, approxInputChars: system.length + user.length, approxOutputChars: text.length });
    save();
    return result;
  } catch (e) {
    if (timedOut && e.code !== 'timeout') { e.code = 'timeout'; }
    throw e;
  } finally {
    clearTimeout(timer);
    busy?.calls.delete(callId);
    if (owner) endBusy(); else updateBusy();
  }
}

const blobToBase64 = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(b); });
async function serverAI(op, payload, signal, images = [], onProgress = () => {}, isTimedOut = () => false) {
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
        if (ev === 'progress') onProgress(j);
        if (ev === 'error') { const e = new Error(j.message); e.code = j.code; throw e; }
        if (ev === 'result') final = j;
      }
    }
  } catch (e) { if (e.code) throw e; if (signal.aborted) { const t = new Error('timeout'); t.code = isTimedOut() ? 'timeout' : 'cancelled'; throw t; } const x = new Error('interrupted'); x.code = 'interrupted'; throw x; }
  if (!final) { const e = new Error('interrupted'); e.code = 'interrupted'; throw e; }
  return final;
}

function updateBusy() {
  const el = document.getElementById('busy-' + busy?.key);
  if (!el || !busy) return;
  const secs = s => Math.round((Date.now() - s) / 1000);
  const calls = [...busy.calls.values()];
  const files = busy.files || [];
  const head = files.length
    ? `Interpretando ${files.length} PDF${files.length === 1 ? '' : 's'} · ${calls.length} lectura${calls.length === 1 ? '' : 's'} simultánea${calls.length === 1 ? '' : 's'} · ${secs(busy.startedAt)} s`
    : `${busy.msg || calls[0]?.msg || 'Procesando…'} · ${secs(busy.startedAt)} s${calls[0]?.chars ? ` · ${calls[0].chars.toLocaleString('es-MX')} caracteres recibidos` : ''}`;
  const fileRows = files.map(f => `<li><span class="pf-name">${esc(f.name)}</span><span class="pf-bar"><span style="width:${f.total ? Math.round((f.done / f.total) * 100) : 0}%"></span></span><span class="pf-st ${f.state === 'error' ? 'err' : f.state === 'listo' ? 'ok' : ''}">${f.state === 'listo' ? 'Listo' : f.state === 'error' ? 'Con error' : f.state === 'en cola' ? 'En espera' : `${f.done} de ${f.total} lote${f.total === 1 ? '' : 's'}`}</span></li>`).join('');
  const callRows = files.length ? calls.map(c => `<li class="pc">${esc(c.label)} · ${esc(c.msg)} · ${secs(c.startedAt)} s${c.chars ? ` · ${c.chars.toLocaleString('es-MX')} car.` : ''}</li>`).join('') : '';
  el.innerHTML = `<span><span class="spinner" aria-hidden="true"></span>${head}</span>${fileRows ? `<ul class="pfiles">${fileRows}</ul>` : ''}${callRows ? `<ul class="pcalls">${callRows}</ul>` : ''}<span class="sub">Puedes usar otra pestaña; no cierres ni recargues esta.</span>`;
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
// Lotes de páginas: cada llamada a Claude recibe pocas páginas para que su respuesta no exceda
// el límite de salida. Una página escaneada cuenta como una página densa.
const CHUNK_BUDGET = 9000; // caracteres de texto de página por lote (≈ 2–3 páginas de movimientos)
const SCAN_PAGE_WEIGHT = 3500;
const pageWeight = p => Math.max(p.scanned ? SCAN_PAGE_WEIGHT : 0, (p.text || '').length, 400);

function buildChunk(f, pages) {
  const imgs = PAGE_IMAGES.get(f.id) || [];
  const chunk = { pages: [], images: [] };
  for (const p of pages) {
    const img = p.scanned ? imgs.find(x => x.number === p.number) : null;
    chunk.pages.push({ ...p, imageIndex: img ? chunk.images.length + 1 : null, imageMissing: p.scanned && !img });
    if (img) chunk.images.push(img.blob);
  }
  return chunk;
}

function interpretChunks(f) {
  const maxImg = Math.max(1, Math.min(AI.maxImages || 5, 20));
  const groups = [[]];
  let weight = 0, imgs = 0;
  for (const p of f.pages) {
    const w = pageWeight(p), isImg = p.scanned && PAGE_IMAGES.has(f.id);
    const cur = groups.at(-1);
    if (cur.length && (weight + w > CHUNK_BUDGET || (isImg && imgs >= maxImg))) { groups.push([]); weight = 0; imgs = 0; }
    groups.at(-1).push(p); weight += w; if (isImg) imgs++;
  }
  return groups.filter(g => g.length);
}

const pageRange = pages => pages.length === 1 ? `${pages[0].number}` : `${pages[0].number}–${pages.at(-1).number}`;

// Mapeo anterior solo de las páginas del lote (evita que un lote repita movimientos de otras páginas).
function previousForPages(prev, pages) {
  if (!prev) return null;
  const nums = new Set(pages.map(p => p.number));
  const all = slimMonth(prev);
  return { ...all, initialBalance: nums.has(1) ? all.initialBalance : null, finalBalance: nums.has(1) ? all.finalBalance : null, movements: all.movements.filter(m => nums.has(m.sourcePageNumber)) };
}

// Interpreta un grupo de páginas; si la respuesta se trunca, lo parte a la mitad y reintenta.
async function interpretPages(f, pages, ctx, depth = 0) {
  const split = f.pages.length > 1 && (pages.length < f.pages.length || ctx.forceSplit);
  const chunk = buildChunk(f, pages);
  const label = `${f.fileName} · ${pages.length === f.pages.length ? 'todas las páginas' : `páginas ${pageRange(pages)} de ${f.pages.length}`}`;
  try {
    const part = await callAI('interpret', { file: { ...f, pages: chunk.pages }, part: split ? { range: pageRange(pages), totalPages: f.pages.length } : null, condo: condoForAI(), previous: split ? previousForPages(ctx.prev, pages) : (ctx.prev ? slimMonth(ctx.prev) : null), answers: ctx.answers }, 'interpret', { images: chunk.images, label });
    return [part];
  } catch (e) {
    if (e?.code === 'rate_limited' && !ctx.waited) {
      ctx.waited = true;
      log('espera', `${f.fileName}: claude.ai pidió esperar; se reintenta en 10 s`);
      await new Promise(r => setTimeout(r, 10000));
      return interpretPages(f, pages, ctx, depth);
    }
    if (e?.code === 'truncated' && pages.length > 1 && depth < 6) {
      ctx.splits++;
      log('lote_dividido', `${f.fileName}: respuesta truncada en páginas ${pageRange(pages)}; se divide en dos lotes`);
      const mid = Math.ceil(pages.length / 2);
      const sub = { ...ctx, forceSplit: true };
      return [...await interpretPages(f, pages.slice(0, mid), sub, depth + 1), ...await interpretPages(f, pages.slice(mid), sub, depth + 1)];
    }
    if (e?.code === 'truncated') throw Object.assign(new Error(`La página ${pageRange(pages)} de «${f.fileName}» produce una respuesta más larga que el límite de Claude incluso leída sola. Revisa si esa página tiene una tabla inusualmente larga.`), { code: 'truncated_page' });
    throw e;
  }
}

function mergeDelinquency(parts, period) {
  const ds = parts.map(p => p.delinquency).filter(d => d?.found);
  if (!ds.length) return { found: false, asOf: null, reportedTotal: null, rows: [] };
  let n = 0;
  return { found: true, asOf: ds.map(d => d.asOf).find(Boolean) || null, reportedTotal: ds.map(d => d.reportedTotal).find(v => v !== null && v !== undefined) ?? null, rows: ds.flatMap(d => d.rows).map(r => ({ ...r, id: `${period}-D${String(++n).padStart(3, '0')}` })) };
}

// Segunda lectura enfocada: si quedaron abonos idénticos sin departamento, Claude revisa solo esas páginas.
async function resolveOrigins(f, month) {
  const groups = E.unidentifiedGroups(month);
  if (!groups.length) return;
  const byPage = new Map();
  for (const g of groups) for (const mv of g) { const k = mv.sourcePageNumber ?? 0; if (!byPage.has(k)) byPage.set(k, []); byPage.get(k).push(mv); }
  let fixed = 0, dropped = 0;
  for (const [pageNo, movs] of byPage) {
    const pages = f.pages.filter(p => pageNo ? p.number === pageNo : true).slice(0, 3);
    if (!pages.length) continue;
    const chunk = buildChunk(f, pages);
    try {
      const res = await callAI('origins', { pages: chunk.pages, movements: movs.map((m, i) => ({ i, date: m.date, concept: m.concept, amount: m.amount, type: m.type })) }, 'interpret', { images: chunk.images, label: `${f.fileName} · identificando departamentos (pág. ${pageNo || '?'})` });
      const drop = new Set();
      for (const o of res.origins) {
        const mv = movs[o.i];
        if (o.duplicate) { drop.add(mv.id); continue; }
        const org = E.formatOrigin(o.origin);
        if (org) { mv.origin = org; fixed++; }
        if (o.concept && o.concept.length >= mv.concept.length) mv.concept = o.concept;
      }
      if (drop.size) {
        dropped += drop.size;
        month.movements = month.movements.filter(m => !drop.has(m.id));
        month.unclassifiedMovements = month.unclassifiedMovements.filter(m => !drop.has(m.id));
        (month.notes = month.notes || []).push({ kind: 'inconsistencia', title: 'Renglones repetidos eliminados', detail: `En la página ${pageNo} la primera lectura repitió ${drop.size} movimiento(s) que no existen en el documento; se eliminaron. Verifica el cuadre del mes.` });
      }
    } catch (e) { log('error_ia', `origins ${f.fileName} pág. ${pageNo}: ${e.code || ''} ${e.message}`); }
  }
  Object.assign(month, E.recomputeMonth(month));
  log('departamentos', `${f.fileName}: ${fixed} movimiento(s) con departamento identificado en segunda lectura${dropped ? `; ${dropped} renglón(es) repetido(s) eliminado(s)` : ''}`);
}

// Une las partes de un mismo estado de cuenta leído en varios lotes.
function mergeParts(parts, f) {
  const first = v => parts.map(p => p[v]).find(x => x !== null && x !== undefined && x !== '');
  const summary = parts.find(p => p.initialBalance !== null && p.initialBalance !== undefined && p.finalBalance !== null && p.finalBalance !== undefined);
  const period = parts.map(p => p.period).find(x => x && x !== f.period) || parts[0].period;
  let n = 0;
  const movements = parts.flatMap(p => [...p.movements, ...p.unclassifiedMovements]).map(m => ({ ...m, id: `${period}-${String(++n).padStart(3, '0')}` }));
  let q = 0;
  const aiQuestions = parts.flatMap(p => p.aiQuestions || []).map(x => ({ ...x, id: `q-ai-${period}-${++q}`, period }));
  return E.recomputeMonth({ ...parts[0], period, initialBalance: summary ? summary.initialBalance : (first('initialBalance') ?? null), finalBalance: summary ? summary.finalBalance : (first('finalBalance') ?? null), reportedIncome: first('reportedIncome') ?? null, reportedExpense: first('reportedExpense') ?? null, pettyCashBalance: first('pettyCashBalance') ?? null, bank: first('bank') || '', accountType: first('accountType') || '', movements, unclassifiedMovements: [], aiQuestions, notes: parts.flatMap(p => p.notes || []), delinquency: mergeDelinquency(parts, period), fundBalances: [...new Map(parts.flatMap(p => p.fundBalances || []).map(b => [`${b.fund}|${b.building}`, b])).values()] });
}

// Interpreta los PDFs con hasta INTERPRET_CONCURRENCY lecturas simultáneas (lotes de páginas de
// uno o varios PDFs). Cada PDF se integra al terminar todos sus lotes; un PDF con error no detiene a los demás.
async function runInterpret(onlyIds = null) {
  const targets = S.files.filter(f => f.status !== 'error' && f.pages?.length && (onlyIds ? onlyIds.includes(f.id) : !S.months.some(m => m.fileId === f.id)));
  if (!targets.length) { errors.interpret = 'No hay PDFs nuevos por interpretar.'; render(); return; }
  if (!aiReady()) { errors.interpret = errorText('not_connected'); render(); return false; }
  errors.interpret = null;
  const failures = [];
  const fail = (f, e, prog) => {
    failures.push(`${f.fileName}: ${['reload_pdf', 'images_unavailable', 'duplicate_period', 'truncated_page'].includes(e.code) ? e.message : errorText(e.code, e.message)}`);
    log('error_ia', `interpret ${f.fileName}: ${e.code || ''} ${e.message}`);
    if (prog) prog.state = 'error';
  };
  startBusy('interpret', { files: [] });
  const jobs = [];
  for (const f of targets) {
    const prev = S.months.find(m => m.fileId === f.id);
    const hasScans = f.pages.some(p => p.scanned);
    if (hasScans && !PAGE_IMAGES.has(f.id) && !prev) { fail(f, Object.assign(new Error('Las páginas escaneadas no se conservan al recargar. Quita el archivo y vuelve a cargar el PDF.'), { code: 'reload_pdf' })); continue; }
    if (hasScans && PAGE_IMAGES.has(f.id) && AI.mode === 'claude.ai' && !AI.maxImages) { fail(f, Object.assign(new Error('Esta vista no permite enviar imágenes a Claude para leer las páginas escaneadas.'), { code: 'images_unavailable' })); continue; }
    const answers = prev ? (prev.aiQuestions || []).filter(q => S.answers[q.id]).map(q => ({ question: q.prompt, answer: S.answers[q.id] })) : [];
    const groups = interpretChunks(f);
    // El mapeo anterior solo se envía si hay aclaraciones que aplicar; al releer, Claude lee de cero.
    const ctx = { prev: answers.length ? prev : null, answers, splits: 0, forceSplit: groups.length > 1 };
    const prog = { name: f.fileName, done: 0, total: groups.length, state: 'en cola' };
    busy.files.push(prog);
    jobs.push({ f, prev, ctx, groups, prog, parts: new Array(groups.length), remaining: groups.length, error: null });
  }
  const finish = async job => {
    const { f, prev, parts, prog } = job;
    try {
      const flat = parts.flat();
      const month = flat.length === 1 ? flat[0] : mergeParts(flat, f);
      await resolveOrigins(f, month);
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
      prog.state = 'listo';
      log(prev ? 'reinterpretación' : 'interpretación', `${f.fileName} → ${month.period}: ${month.movements.length + month.unclassifiedMovements.length} movimientos en ${job.groups.length} lote${job.groups.length === 1 ? '' : 's'}${scannedPages.size ? ` (${scannedPages.size} páginas escaneadas leídas como imagen)` : ''}`);
    } catch (e) { fail(f, e, prog); }
    save(); render();
  };
  const tasks = jobs.flatMap(job => job.groups.map((g, gi) => async () => {
    if (job.error) return;
    if (job.prog.state === 'en cola') job.prog.state = 'leyendo';
    try { job.parts[gi] = await interpretPages(job.f, g, job.ctx); }
    catch (e) { if (!job.error) { job.error = e; fail(job.f, e, job.prog); save(); render(); } return; }
    job.prog.done++; updateBusy();
    if (--job.remaining === 0) await finish(job);
  }));
  try { await runPool(tasks, INTERPRET_CONCURRENCY); }
  finally { endBusy(); }
  errors.interpret = failures.length ? failures.join('\n') : null;
  save(); render();
  return failures.length === 0;
}
const slimMonth = m => ({ period: m.period, initialBalance: m.initialBalance, finalBalance: m.finalBalance, movements: [...m.movements, ...m.unclassifiedMovements].map(x => ({ date: x.date, concept: x.concept, amount: x.amount, type: x.type, category: x.category, sourcePageNumber: x.sourcePageNumber, fund: x.fund, origin: x.origin })) });

async function runAnalyze() {
  errors.analyze = null;
  const ms = months();
  const ind = indicators();
  const anomalies = E.detectAnomalies(ms, ind, { observations: observations() });
  const movs = allMovements().map(m => ({ id: m.id, date: m.date, concept: m.concept, origin: m.origin || undefined, amount: m.amount, type: m.type, category: m.category, fund: m.fund }));
  try {
    const delinquency = E.delinquencyRows(ms).map(r => ({ id: r.id, period: r.period, unit: r.unit, amount: r.amount, months: r.months }));
    const ai = await callAI('analyze', { condo: condoForAI(), indicators: ind, anomalies, movements: movs, delinquency, observations: observations().map(o => ({ movementId: o.movementId, period: o.period, text: o.text })) }, 'analyze');
    S.diagnosis = { at: now(), hash: mappingHash(), indicators: ind, anomalies, ai };
    invalidate('selection'); S.selection = [];
    log('diagnóstico', `${ai.findings.length} hallazgos propuestos; ${anomalies.length} reglas disparadas`);
  } catch (e) { errors.analyze = errorText(e.code, e.message); log('error_ia', `analyze: ${e.code || ''} ${e.message}`); }
  save(); render();
}
const condoForAI = () => ({ name: CONDO.name, address: CONDO.address, context: CONDO.context, units: CONDO.units, bank: S.meta.bank, accountType: S.meta.accountType, currency: S.meta.currency });

// Evidencia citable: movimientos bancarios y filas del reporte de morosidad.
function evidenceIndex() {
  const mv = new Map(allMovements().map(m => [m.id, m]));
  for (const r of E.delinquencyRows(months())) mv.set(r.id, { id: r.id, date: r.asOf || r.period, concept: `Adeudo ${r.unit}${r.months ? ` (${r.months} meses)` : ''}`, amount: r.amount, type: 'morosidad' });
  return mv;
}

function selectedFindings() {
  const props = S.diagnosis?.ai?.findings || [];
  const mv = evidenceIndex();
  return S.selection.map(s => {
    const p = props.find(f => f.id === s.id);
    return { ...p, level: s.level, acceptedHypotheses: (p.hypotheses || []).filter((_, k) => (s.acceptedHypotheses || []).includes(k)), evidenceMovements: (p.evidence || []).map(id => mv.get(id)).filter(Boolean).map(m => ({ id: m.id, date: m.date, concept: m.concept, amount: m.amount, type: m.type })) };
  });
}

async function runReport() {
  errors.report = null;
  const obs = S.observationsDraft || '';
  try {
    const ai = await callAI('report', { condo: condoForAI(), indicators: indicators(), diagnosis: { executiveSummary: S.diagnosis.ai.executiveSummary, facts: S.diagnosis.ai.facts, interpretation: S.diagnosis.ai.interpretation || S.diagnosis.ai.trends, hypotheses: S.diagnosis.ai.hypotheses, comparabilityNote: S.diagnosis.ai.comparabilityNote }, findings: selectedFindings(), observations: obs }, 'report');
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
    const ai = await callAI('alert', { role: S.role, reviewer: S.review?.reviewer, observations: observations().map(o => ({ period: o.period, text: o.text })), condo: condoForAI(), period: ind.periodFrom === ind.periodTo ? ind.periodFrom : `${ind.periodFrom} a ${ind.periodTo}`, date: new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' }), report: S.report.ai, findings: selectedFindings(), indicators: { months: ind.months, committedFunds: ind.committedFunds, freeBalance: ind.freeBalance, bankBalance: ind.bankBalance } }, 'alert');
    S.alert = { at: now(), ai, acceptedAt: null };
    log('nota_alerta', 'Nota de alerta generada');
  } catch (e) { errors.alert = errorText(e.code, e.message); log('error_ia', `alert: ${e.code || ''} ${e.message}`); }
  save(); render();
}

async function testConnection() {
  errors.connect = null;
  if (AI.mode !== 'claude.ai') openConnectDialog();
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
  S = migrate(n); save(); render();
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
  const scrollTop = document.querySelector('main')?.scrollTop || 0;
  root.innerHTML = `
  <header class="topbar">
    <img class="logo" src="${LOGO}" alt="Escudo del Condominio Hampton Court" width="60" height="61">
    <div class="tb-text">
      <h1 class="apptitle">Análisis de estados de cuenta - <span>Condominio Hampton Court</span></h1>
      <div class="tb-sub"><span class="addr">${esc(CONDO.address)} · ${CONDO.units} departamentos</span><span class="conn">${connBadge()}</span></div>
    </div>
  </header>
  <div class="shell">
    <nav class="rail" aria-label="Etapas del análisis"><ol>${STAGES.map(st => `<li><button class="step ${done(st.n) ? 'done' : ''}" data-go="${st.n}" ${enabled(st.n) ? '' : 'disabled'} ${S.stage === st.n ? 'aria-current="step"' : ''}><span class="n">${done(st.n) ? '✓' : st.n}</span><span class="t">${st.t}<span class="s">${done(st.n) ? 'Completada' : enabled(st.n) ? st.s : 'Bloqueada'}</span></span></button></li>`).join('')}</ol>
    <p class="note">El análisis se guarda solo en este navegador. Sin sincronización entre equipos: usa la copia JSON para cambiar de equipo.</p></nav>
    <main><div class="wrap">${banners()}${stageView()}${abandonView()}${logView()}</div></main>
  </div>`;
  const mainEl = document.querySelector('main');
  if (mainEl) mainEl.scrollTop = scrollTop;
  if (busy) updateBusy();
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus({ preventScroll: true });
  wireAfterRender();
}

function connBadge() {
  if (!AI.checked) return '<span class="dot"></span>Comprobando conexión…';
  if (AI.mode === 'claude.ai') return AI.sample ? `<span class="dot ok"></span>Claude disponible vía claude.ai` : '<span class="dot err"></span>Claude no disponible';
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
  <section class="panel"><h2>¿Quién hace esta revisión?</h2>
    <p class="lead">El rol define qué puedes hacer con cada aclaración y a quién va dirigida la nota final. Puedes cambiarlo después.</p>
    <div class="roles" role="radiogroup" aria-label="Rol de quien revisa">${Object.entries(E.ROLES).map(([k, r]) => `<label class="role-card ${S.role === k ? 'on' : ''}"><input type="radio" name="role" id="role-${k}" data-role="${k}" ${S.role === k ? 'checked' : ''}><span class="rc-t">${esc(r.label)}</span><span class="rc-d">${esc(r.desc)}</span><span class="rc-n">Nota final: ${esc(r.note)}</span></label>`).join('')}</div>
  </section>
  ${S.months.length ? `<div class="banner warn"><span>Este análisis ya contiene ${S.months.length} mes${S.months.length === 1 ? '' : 'es'} interpretado${S.months.length === 1 ? '' : 's'} (${E.sortMonths(S.months).map(m => esc(m.period)).join(', ')}) de cargas anteriores, guardados en este navegador. Los PDFs nuevos se agregan a ellos. Si quieres analizar solo un estado de cuenta, usa «Interrumpir y comenzar nuevo análisis» al final de esta pantalla.</span></div>` : ''}
  <section class="panel"><h2>Estados de cuenta (PDF)</h2>
    <div class="drop" id="drop"><strong>Arrastra aquí los PDFs</strong><span>o</span><label class="btn sm" for="pdf-in">Elegir archivos</label><input id="pdf-in" type="file" accept="application/pdf,.pdf" multiple hidden><span class="hint" style="font-size:12px;color:var(--ink-3)">Hasta 12 archivos · 20 MB y 100 páginas cada uno · PDF con texto, escaneado o mixto: las páginas escaneadas se leen como imagen</span></div>
    ${errors.files ? `<div class="status err" role="alert">${esc(errors.files)}</div>` : ''}
    ${S.files.length ? `<ul class="files">${S.files.map(f => `<li><div class="stack"><span class="fn">${esc(f.fileName)}</span><span class="meta">${f.status === 'leyendo' ? `<span class="spinner"></span><span data-reading="${f.id}">Leyendo…</span>` : f.status === 'error' ? `<span style="color:var(--crit)">${esc(f.error)}</span>` : `${f.pages.length} pág.${f.pages.some(p => p.scanned) ? ` (${f.pages.filter(p => p.scanned).length} escaneada${f.pages.filter(p => p.scanned).length === 1 ? '' : 's'}${f.pages.some(p => p.scanned) && !PAGE_IMAGES.has(f.id) ? '; vuelve a cargar el PDF para leerlas' : ''})` : ''} · período ${esc(f.period || 'por identificar')} · ${esc(f.status)}`}</span></div><div class="row">${f.status === 'error' && f._file ? `<button class="btn sm" data-act="retry-file" data-id="${f.id}" ${dis()}>Reintentar</button>` : ''}<button class="btn sm danger" data-act="remove-file" data-id="${f.id}" ${dis(S.closedAt)}>Quitar</button></div></li>`).join('')}</ul>` : ''}
  </section>
  <section class="panel"><h2>${AI.mode === 'claude.ai' ? 'Claude y autorización' : 'Conexión y consentimiento'}</h2>
    ${AI.mode === 'claude.ai'
      ? `<div class="row"><span class="conn">${connBadge()}</span></div>
    ${AI.checked && !AI.sample ? `<div class="banner err" role="alert"><span>${esc(AI.error || 'Claude no está disponible en esta vista.')} Abre la aplicación en claude.ai con tu sesión iniciada.</span></div>` : '<p>La primera lectura te pedirá permiso en claude.ai para usar Claude; el consumo corresponde a tu cuenta.</p>'}`
      : `<p>Esta versión llama a la API de Anthropic desde el servidor con tu clave cifrada (AES-GCM). El consumo corresponde a esa cuenta API.</p>
    <div class="row"><button class="btn" data-act="connect" ${dis()}>${AI.server?.connected ? 'Reemplazar o eliminar clave' : 'Conectar Claude'}</button><span class="conn">${connBadge()}</span></div>
    ${statusFor('connect')}`}
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
  const adminFund = E.computeAdminFund(ms, S.fundOpenings);
  const funds = fundRows(adminFund, E.computeFunds(ms, S.fundOpenings));
  const pend = pendingTextAnswers();
  const block = blockingOpen();
  const conf = S.confirmation;
  const checks = S._checks || (S._checks = {});
  const allChecked = ['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity', 'delinquency'].every(k => checks[k]);
  const morMonths = ms.filter(m => m.delinquency?.found).length;
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
  <section class="panel"><h2>Fondos identificados ${src('motor')}</h2>
    ${funds.length ? `<p class="lead">Si un fondo tenía saldo antes del período, indícalo. El Fondo de Administración y Mantenimiento es el fondo operativo: reúne los ingresos ordinarios y no cuenta como fondo comprometido.${adminFund ? ' Los gastos corrientes de operación (vigilancia, limpieza, jardinería, CFE, honorarios, mantenimiento y similares) se aplican automáticamente a este fondo; los egresos con fondo «No especificado» no se descuentan de ninguno.' : ''}</p><div class="tbl-wrap"><table class="funds-tbl"><thead><tr><th>Fondo</th><th>Edificio</th><th class="n">Saldo previo ${src('user')}</th><th class="n">Recaudado</th><th class="n">Aplicado</th><th class="n">Saldo calculado ${src('motor')}</th><th class="n">Saldo reportado ${src('pdf')}</th></tr></thead><tbody>${funds.map((f, i) => {
      const key = f.key || f.name;
      const label = f.kind === 'op' ? `${esc(f.name)} <span class="pill ok">Operativo</span>` : f.kind === 'subtotal' ? `<b>${esc(f.name)}</b>` : esc(f.kind === 'reserve' ? 'Fondo de Reserva' : f.name);
      const bld = f.kind === 'reserve' ? (f.building ? `<span class="pill bld">${esc(f.building)}</span>` : '<span class="muted">Sin edificio identificado</span>') : f.kind === 'subtotal' ? '' : esc(f.buildingOrScope || '—');
      const rep = f.reportedBalance === null || f.reportedBalance === undefined ? '<span class="muted">No reportado</span>' : `<b>${E.fmtMXN(f.reportedBalance)}</b>${f.reportedPeriod ? `<span class="rep-p">al ${esc(f.reportedAsOf || f.reportedPeriod)}</span>` : ''}`;
      return `<tr class="${f.kind === 'op' ? 'fund-op' : f.kind === 'subtotal' ? 'subtotal' : ''}"><td>${label}</td><td>${bld}</td><td class="n">${f.kind === 'subtotal' ? E.fmtMXN(f.opening) : `<input type="number" class="fund-open" step="0.01" id="fund-${i}" data-fund="${esc(key)}" value="${esc(S.fundOpenings[key] ?? '')}" placeholder="0.00">`}</td><td class="n">${E.fmtMXN(f.amountCollected)}</td><td class="n">${E.fmtMXN(f.amountPaid)}</td><td class="n">${E.fmtMXN(f.balance)}</td><td class="n">${rep}</td></tr>`;
    }).join('')}</tbody></table></div><p class="muted">El Fondo de Reserva se muestra por edificio. Saldo calculado = saldo previo + recaudado − aplicado en los meses analizados. Saldo reportado = el que muestra el estado de cuenta al corte; cuando existe, se usa para el fondo comprometido y no hace falta capturar el saldo previo.</p>` : '<p>No se detectaron fondos (ni ingresos ordinarios ni fondos especiales como impermeabilización, canaletas, reserva o anticipos).</p>'}
  </section>
  <section class="panel" id="questions"><h2>Aclaraciones pendientes (${qs.length})</h2>
    <p class="lead">${S.role === 'admin' ? 'Responde las que puedas con tu documentación; deja anotadas las que requieran revisión posterior.' : 'Tú solo tienes el estado de cuenta: envía cada duda como observación a la administración (puedes editar la redacción sugerida) o respóndela si tienes la información.'}</p>
    ${qs.length ? qs.map(q => questionView(q, catOpts)).join('') : '<p>No hay preguntas pendientes.</p>'}
  </section>
  ${observationsPanel()}
  <section class="panel"><div class="row" style="justify-content:space-between"><h2>Confirmación</h2><div class="row">
      <button class="btn sm" data-act="check-all" ${dis(allChecked)}>Seleccionar todo</button>
      <button class="btn sm ghost" data-act="check-none" ${dis(!Object.values(checks).some(Boolean))}>Deseleccionar todo</button></div></div>
    <div class="stack">
      ${[['currency', 'La moneda es MXN.'], ['bank', `El banco (${esc(S.meta.bank || 'sin indicar')}) y el tipo de cuenta son correctos.`], ['period', `El período cubierto (${esc(ms[0]?.period)} → ${esc(ms.at(-1)?.period)}) es correcto.`], ['categories', 'Revisé las categorías asignadas a los movimientos.'], ['funds', 'Los fondos especiales identificados son correctos.'], ['arithmetic', `Revisé el cuadre aritmético de cada mes (${ms.filter(m => !m.balanceCheck).length} con diferencia).`], ['continuity', `Revisé la continuidad de saldos entre meses (${cont.filter(c => !c.ok && c.consecutive).length} discontinuidades).`], ['delinquency', `Revisé el reporte de morosidad por departamento (${morMonths} de ${ms.length} meses con reporte).`]].map(([k, t]) => `<label class="check"><input type="checkbox" id="chk-${k}" data-check="${k}" ${checks[k] ? 'checked' : ''}><span>${t}</span></label>`).join('')}
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
  const obsIds = new Set(observations().map(o => o.movementId).filter(Boolean));
  const oopIds = new Set(m.outOfPeriodDecision === 'keep' ? [] : E.outOfPeriod(m).map(x => x.id));
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
    ${oopIds.size ? `<span class="pill bad">${oopIds.size} fuera del período</span>` : ''}
    ${(m.excludedMovements || []).length ? `<span class="pill neutral">${m.excludedMovements.length} excluidos</span>` : ''}
  </summary><div class="body">
    <div class="grid3">
      <label class="f">Saldo inicial ${src('pdf')}<input type="number" step="0.01" id="ini-${m.period}" data-month="${m.period}" data-field="initialBalance" value="${m.initialBalance ?? ''}" placeholder="No identificado"></label>
      <label class="f">Saldo final ${src('pdf')}<input type="number" step="0.01" id="fin-${m.period}" data-month="${m.period}" data-field="finalBalance" value="${m.finalBalance ?? ''}" placeholder="No identificado"></label>
      <div class="kpi"><span class="l">Saldo final esperado ${src('motor')}</span><span class="v">${E.fmtMXN(m.expectedFinal)}</span><span class="l">inicial + ingresos − egresos</span></div>
    </div>
    ${m.reportedIncome !== null || m.reportedExpense !== null ? `<p class="lead" style="font-size:13px">Resumen del estado ${src('pdf')}: depósitos ${E.fmtMXN(m.reportedIncome)} · retiros ${E.fmtMXN(m.reportedExpense)}. Diferencia con movimientos ${src('motor')}: ingresos ${E.fmtMXN(m.incomeVsReported)}, egresos ${E.fmtMXN(m.expenseVsReported)}.</p>` : ''}
    ${notesView(m.notes)}
    <div class="tbl-wrap"><table><thead><tr><th class="n">No.</th><th>Fecha</th><th>Concepto original ${src('pdf')}</th><th>Origen</th><th>Tipo</th><th class="n">Monto</th><th>Tipo de fondo</th><th>Categoría</th><th>Pág.</th></tr></thead><tbody>
    ${movs.map((x, i) => `<tr class="${x.amount === null || oopIds.has(x.id) ? 'flag' : x.category === 'NO_CLASIFICADO' ? 'unc' : ''}" id="mv-${esc(x.id)}"><td class="n mono rownum">${i + 1}</td><td class="mono date-c">${esc(x.date)}</td><td title="${esc(x.sourceText)}">${esc(x.concept)}${x.fromScan ? ' <span class="pill scan" title="Leído de una página escaneada: verifica el importe">Escaneado</span>' : ''}${oopIds.has(x.id) ? ' <span class="pill bad" title="La fecha está fuera del período del estado de cuenta">Fuera del período</span>' : ''}${obsIds.has(x.id) ? ' <span class="pill moderate" title="Enviado como observación a la administración">Sin aclarar</span>' : ''}</td><td>${originCell(x)}</td><td><span class="pill ${x.type === 'abono' ? 'abono' : 'cargo'}">${x.type === 'abono' ? 'Abono' : 'Cargo'}</span></td><td class="n">${x.amount === null ? `<input type="number" step="0.01" min="0" id="amt-${esc(x.id)}" data-amt="${esc(x.id)}" placeholder="No identificado">` : E.fmtMXN(x.amount)}</td><td>${fundCell(x)}</td><td><select id="cat-${esc(x.id)}" data-cat="${esc(x.id)}" aria-label="Categoría de ${esc(x.concept)}">${catOpts(x.category)}</select>${x.engineSuggestion && x.engineSuggestion !== x.category && x.engineSuggestion !== 'NO_CLASIFICADO' ? `<div style="font-size:11px;color:var(--ink-3)">Motor sugiere: ${esc(E.catLabel(x.engineSuggestion))}</div>` : ''}</td><td class="mono">${x.sourcePageNumber ?? '—'}</td></tr>`).join('')}
    </tbody></table></div>
    ${corr.length ? `<div class="stack"><strong style="font-size:13px">Correcciones documentadas ${src('user')}</strong>${corr.map(c => `<span style="font-size:13px;color:var(--ink-2)">${esc(new Date(c.at).toLocaleString('es-MX'))} · ${esc(c.what)}${c.why ? ` — «${esc(c.why)}»` : ''}</span>`).join('')}</div>` : ''}
    ${delinquencyMonth(m)}
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

// Celdas editables de la tabla de movimientos.
function originCell(x) {
  const applies = x.type === 'abono' || x.origin || /REEMBOLSO|DEVOLUCION|REINTEGRO/.test(E.normText(x.concept));
  if (!applies) return '<span class="muted">—</span>';
  return `<input type="text" class="origin-in ${x.origin ? '' : 'empty'}" id="org-${esc(x.id)}" data-origin="${esc(x.id)}" value="${esc(x.origin || '')}" placeholder="No identificado" maxlength="40" aria-label="Origen de ${esc(x.concept)}">`;
}
function fundCell(x) {
  const opts = E.FUND_OPTIONS.includes(x.fund) ? E.FUND_OPTIONS : [x.fund, ...E.FUND_OPTIONS];
  return `<select class="fund-sel ${x.fund === E.FUND_NONE ? 'none' : x.fund === E.FUND_ADMIN ? 'admin' : 'special'}" id="fnd-${esc(x.id)}" data-mvfund="${esc(x.id)}" aria-label="Tipo de fondo de ${esc(x.concept)}">${opts.map(o => `<option ${o === x.fund ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

function delinquencyMonth(m) {
  const d = m.delinquency;
  const reread = `<button class="btn sm" data-act="reread" data-file="${esc(m.fileId)}" ${dis()}>Volver a leer este mes con Claude</button>`;
  if (!d) return `<div class="mor"><div class="mor-h"><h4>Reporte de morosidad por departamento</h4></div><div class="banner warn"><span>Este mes se interpretó antes de que la aplicación leyera el reporte de morosidad. Vuelve a leerlo para incorporarlo; después deberás confirmar los datos otra vez.</span></div><div class="row">${reread}</div>${statusFor('interpret')}</div>`;
  if (!d.found) return `<div class="mor"><div class="mor-h"><h4>Reporte de morosidad por departamento</h4></div><p class="muted">Claude no encontró un reporte de morosidad en este PDF. Si el documento sí lo incluye, vuelve a leer el mes.</p><div class="row">${reread}</div></div>`;
  const total = E.round2(d.rows.reduce((s, r) => s + Number(r.amount || 0), 0));
  const diff = d.reportedTotal === null ? null : E.round2(d.reportedTotal - total);
  const owing = d.rows.filter(r => Number(r.amount) > 0).length;
  return `<div class="mor"><div class="mor-h"><h4>Reporte de morosidad por departamento ${src('pdf')}</h4><span class="pill neutral">${owing} de ${CONDO.units} departamentos con adeudo</span>${d.asOf ? `<span class="pill neutral">Corte ${esc(d.asOf)}</span>` : ''}${diff === null ? '' : Math.abs(diff) <= 1 ? '<span class="pill ok">Total cuadra</span>' : `<span class="pill bad">Total del reporte difiere ${E.fmtMXN(diff)}</span>`}</div>
    <div class="tbl-wrap"><table><thead><tr><th>Departamento</th><th class="n">Adeudo</th><th class="n">Meses</th><th>Detalle</th><th>Pág.</th></tr></thead><tbody>
    ${d.rows.map(r => `<tr class="${r.amount === null ? 'flag' : Number(r.months) >= 3 ? 'unc' : ''}"><td>${esc(r.unit)}</td><td class="n">${E.fmtMXN(r.amount)}</td><td class="n">${r.months ?? '—'}</td><td>${esc(r.detail || '')}</td><td class="mono">${r.sourcePageNumber ?? '—'}</td></tr>`).join('')}
    </tbody><tfoot><tr><td><b>Suma por departamento</b> ${src('motor')}</td><td class="n"><b>${E.fmtMXN(total)}</b></td><td colspan="3">${d.reportedTotal !== null ? `Total del reporte: ${E.fmtMXN(d.reportedTotal)}` : ''}</td></tr></tfoot></table></div></div>`;
}

// Movimiento al que se refiere una pregunta. Valida la liga guardada (los ids cambian al unir lotes o
// excluir renglones) y, si no coincide, la busca por monto, fecha y departamento.
function questionMovement(q) {
  const m = months().find(x => x.period === q.period);
  const movs = m ? [...m.movements, ...m.unclassifiedMovements] : allMovements();
  const saved = q.movementId ? movs.find(x => x.id === q.movementId) : null;
  if (saved && (q.kind !== 'text' || E.linkQuestionMovement(q.prompt, 0, [saved]) === saved.id)) return saved;
  if (q.kind !== 'text') return saved;
  const id = E.linkQuestionMovement(q.prompt, null, movs);
  return id ? movs.find(x => x.id === id) : null;
}

function questionView(q, catOpts) {
  const mv = questionMovement(q);
  const id = esc(q.id);
  let answer = '';
  if (q.kind === 'category') answer = `<select id="qa-${id}" data-qcat="${esc(q.movementId)}"><option value="">Elegir categoría…</option>${catOpts('')}</select>`;
  else if (q.kind === 'amount') answer = `<input type="number" step="0.01" min="0" id="qa-${id}" data-qamt="${esc(q.movementId)}" placeholder="Monto en MXN">`;
  else if (q.kind === 'balance') answer = `<input type="number" step="0.01" id="qa-${id}" data-qbal="${esc(q.period)}|${esc(q.field)}" placeholder="Monto en MXN">`;
  else if (q.kind === 'origin') answer = '<p class="muted">Captura el origen de cada abono en la columna «Origen» de la tabla.</p>';
  else answer = `<textarea id="qa-${id}" data-qtext="${id}" placeholder="Tu respuesta">${esc(S.answers[q.id] || '')}</textarea>`;
  const draft = q.observationDraft || `Se solicita a la administración aclarar lo siguiente: ${q.prompt}`;
  let body;
  if (q.kind === 'outofperiod') body = `<div class="row"><button class="btn sm danger" data-act="oop-exclude" data-period="${esc(q.period)}" ${dis()}>Excluir ${q.count} movimiento(s) fuera del período</button><button class="btn sm" data-act="oop-keep" data-period="${esc(q.period)}" ${dis()}>Conservarlos (son movimientos reales)</button></div>`;
  else if (S.role === 'admin') body = `${answer}<div class="row q-actions"><button class="btn sm" data-act="q-obs" data-q="${id}" ${dis()}>${esc(R().obsAction)}</button><button class="btn sm ghost" data-act="q-dismiss" data-q="${id}" ${dis()}>No es relevante</button></div><input type="hidden" id="obs-${id}" value="${esc(draft)}">`;
  else body = `<label class="f obs-draft">Observación sugerida para la administración ${q.kind === 'text' ? src('ia') : src('motor')}<textarea id="obs-${id}" rows="2">${esc(draft)}</textarea></label>
    <div class="row q-actions"><button class="btn sm primary" data-act="q-obs" data-q="${id}" ${dis()}>${esc(R().obsAction)}</button><button class="btn sm" data-act="q-answer" data-q="${id}" ${dis()}>${answerOpen.has(q.id) ? 'Ocultar respuesta' : 'Tengo la respuesta'}</button><button class="btn sm ghost" data-act="q-dismiss" data-q="${id}" ${dis()}>No es relevante</button></div>
    ${answerOpen.has(q.id) || (q.kind === 'text' && (S.answers[q.id] || '').trim()) ? `<div class="q-answer">${answer}</div>` : ''}`;
  return `<div class="q ${q.blocking ? 'blocking' : ''}" id="q-${id}"><div class="row">${q.blocking ? '<span class="pill critical">Bloqueante</span>' : '<span class="pill neutral">Informativa</span>'}<span class="pill neutral">${esc(q.period)}</span>${q.kind === 'text' ? src('ia') : src('motor')}</div><p>${esc(q.prompt)}</p>${mv ? `<p style="font-size:13px;color:var(--ink-2)">Movimiento: ${esc(mv.date)} · ${esc(mv.concept)} · ${E.fmtMXN(mv.amount)} · <a href="#mv-${esc(mv.id)}" data-scroll="mv-${esc(mv.id)}">ver en la tabla</a></p>` : ''}${body}</div>`;
}

// Observaciones enviadas a la administración (o puntos pendientes del administrador).
function observationsPanel() {
  const obs = observations();
  const dis_ = dismissed();
  if (!obs.length && !dis_.length) return '';
  return `<section class="panel" id="observations"><div class="row" style="justify-content:space-between"><h2>${esc(R().obsPanel)} (${obs.length}) ${src('user')}</h2>${obs.length ? `<button class="btn sm" data-act="obs-copy">Copiar lista</button>` : ''}</div>
    ${obs.length ? `<ol class="obs-list">${obs.map(o => `<li><div class="row"><span class="pill neutral">${esc(o.period)}</span>${o.blocking ? '<span class="pill critical">Era bloqueante</span>' : ''}${o.movementId ? `<a href="#mv-${esc(o.movementId)}" data-scroll="mv-${esc(o.movementId)}">ver movimiento</a>` : ''}<button class="btn sm ghost" data-act="obs-remove" data-q="${esc(o.qid)}">Quitar</button></div><textarea id="obst-${esc(o.qid)}" data-obstext="${esc(o.qid)}" rows="2">${esc(o.text)}</textarea></li>`).join('')}</ol>` : ''}
    ${dis_.length ? `<p class="muted">${dis_.length} aclaración(es) marcadas como no relevantes. <button class="btn sm ghost" data-act="dismiss-restore">Restaurarlas</button></p>` : ''}
    <span class="status" id="obs-copy-status"></span></section>`;
}

// ----- Etapa 3 -----
function stage3() {
  const ind = S.diagnosis?.indicators || indicators();
  const an = S.diagnosis?.anomalies || E.detectAnomalies(months(), ind, { observations: observations() });
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
  ${delinquencyPanel(ind)}
  <section class="panel"><h2>Indicadores de alerta</h2>
    <div class="grid3">
      <div class="kpi"><span class="l">Morosidad conocida</span><span class="v">${ind.delinquentDebt === null ? 'Sin datos' : E.fmtMXN(ind.delinquentDebt)}</span></div>
      <div class="kpi"><span class="l">Gastos atípicos (reglas)</span><span class="v">${an.filter(a => ['unusual_expense', 'potential_duplicate'].includes(a.kind)).length}</span></div>
      <div class="kpi"><span class="l">Saldo comprometido</span><span class="v">${ind.committedPct === null ? '—' : ind.committedPct + '%'}</span></div>
    </div>
    <h3>Reglas disparadas por el motor (${an.length}) ${src('motor')}</h3>
    ${an.length ? `<div class="tbl-wrap"><table><thead><tr><th>Id</th><th>Nivel</th><th>Regla</th><th>Detalle</th></tr></thead><tbody>${an.map(a => `<tr><td class="mono">${a.id}</td><td><span class="pill ${a.level}">${E.LEVEL_LABEL[a.level]}</span></td><td>${esc(a.title)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Ninguna regla de anomalía se disparó con los datos confirmados.</p>'}
  </section>
  ${ai ? `${diagnosisReading(ai, an)}
  <section class="panel"><h2>Hallazgos propuestos (${ai.findings.length}) ${src('ia')}</h2>${ai.findings.map(f => findingCard(f)).join('')}</section>` : ''}
  <div class="actionbar">
    <button class="btn ${ai ? '' : 'primary'}" data-act="analyze" ${dis()}>${ai ? 'Regenerar diagnóstico' : 'Generar diagnóstico con Claude'}</button>
    <button class="btn ghost" data-go="2" ${dis()}>Volver a confirmar datos</button>
    ${ai && !stale ? '<button class="btn primary" data-go="4">Continuar a hallazgos</button>' : ''}
    ${statusFor('analyze')}
  </div>`;
}

function delinquencyPanel(ind) {
  const D = ind.delinquency;
  if (!D || !D.perMonth.length) return `<section class="panel"><h2>Morosidad por departamento</h2><p>Ninguno de los estados de cuenta confirmados incluye un reporte de morosidad leído. Vuelve a confirmar datos y usa «Volver a leer este mes con Claude» para incorporarlo.</p></section>`;
  const k = (l, v, sub = '') => `<div class="kpi"><span class="l">${l}</span><span class="v">${v}</span>${sub ? `<span class="l">${sub}</span>` : ''}</div>`;
  const st = { 'nuevo': 'bad', 'aumentó': 'bad', 'disminuyó': 'ok', 'liquidado': 'ok', 'sin cambio': 'neutral', 'sin comparación': 'neutral' };
  return `<section class="panel"><h2>Morosidad por departamento ${src('pdf')} ${src('motor')}</h2>
    ${D.missingPeriods.length ? `<div class="banner warn"><span>Sin reporte de morosidad leído en: ${D.missingPeriods.map(esc).join(', ')}.</span></div>` : ''}
    <div class="kpis">
      ${k(`Adeudo total al ${esc(D.latestPeriod)}`, E.fmtMXN(D.latestTotal), D.changePct === null ? '' : `${D.changePct > 0 ? '+' : ''}${D.changePct}% vs. mes anterior`)}
      ${k('Departamentos con adeudo', `${D.unitsOwing} de ${CONDO.units}`, D.unitsPct === null ? '' : `${D.unitsPct}% del condominio`)}
      ${k('Con 3 meses o más', String(D.oldDebtUnits.length), E.fmtMXN(D.oldDebtUnits.reduce((s, u) => s + u.current, 0)))}
      ${k('Índice de morosidad', ind.delinquencyIndexPct === null ? '—' : `${ind.delinquencyIndexPct}%`, 'del ingreso ordinario anualizado')}
    </div>
    ${D.perMonth.length > 1 ? `<div class="tbl-wrap"><table><thead><tr><th>Mes</th><th class="n">Adeudo total</th><th class="n">Departamentos</th><th class="n">Total del reporte</th></tr></thead><tbody>${D.perMonth.map(p => `<tr><td>${esc(p.period)}</td><td class="n">${E.fmtMXN(p.total)}</td><td class="n">${p.unitsOwing}</td><td class="n">${E.fmtMXN(p.reportedTotal)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="tbl-wrap"><table><thead><tr><th>Departamento</th>${D.periods.map(p => `<th class="n">${esc(p)}</th>`).join('')}<th class="n">Meses</th><th>Tendencia</th></tr></thead><tbody>
      ${D.units.map(u => `<tr class="${Number(u.monthsOwed) >= 3 && u.current > 0 ? 'unc' : ''}"><td>${esc(u.unit)}</td>${D.periods.map(p => `<td class="n">${p in u.amounts ? E.fmtMXN(u.amounts[p]) : '—'}</td>`).join('')}<td class="n">${u.monthsOwed ?? '—'}</td><td><span class="pill ${st[u.status]}">${esc(u.status)}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted">Filas resaltadas: adeudo de 3 meses o más en el último corte.</p></section>`;
}

// Lectura del diagnóstico en tres planos visualmente distintos: hechos, interpretación e hipótesis.
function diagnosisReading(ai, an) {
  const legacy = !(ai.facts || []).length;
  const facts = legacy ? an.map(a => ({ text: a.detail, source: 'motor' })) : ai.facts;
  const interp = (ai.interpretation || ai.trends || []).filter(Boolean);
  const hyps = ai.hypotheses || [];
  return `<section class="panel"><h2>Resumen ejecutivo ${src('ia')}</h2><p class="summary">${hlAmounts(ai.executiveSummary)}</p>
    ${ai.comparabilityNote ? `<p class="lead">${esc(ai.comparabilityNote)}</p>` : ''}
    ${legacy ? '<div class="banner warn">Este diagnóstico se generó con el formato anterior. Los hechos mostrados provienen del motor; regenera el diagnóstico para que Claude separe hechos, interpretación e hipótesis.</div>' : ''}
    <div class="planes">
      ${planeBlock('fact', 'Hechos', 'Verificables contra el estado de cuenta o calculados por el motor', facts.map(f => `<li>${src(f.source === 'pdf' ? 'pdf' : 'motor')}<span>${hlAmounts(f.text)}</span></li>`))}
      ${planeBlock('interp', 'Interpretación', 'Lo que Claude concluye a partir de los hechos', interp.map(t => `<li><span>${hlAmounts(t)}</span></li>`))}
      ${planeBlock('hyp', 'Hipótesis', 'Posibles causas por confirmar; no son hechos', hyps.map(h => `<li><span>${hlAmounts(h.text)}</span>${h.quantified ? ' <span class="pill neutral">cuantificada</span>' : ''}</li>`))}
    </div></section>`;
}
function planeBlock(kind, title, sub, items) {
  if (!items.length) return '';
  return `<section class="plane ${kind}"><header><span class="plane-k">${title}</span><span class="plane-s">${sub}</span></header><ul>${items.join('')}</ul></section>`;
}

function findingCard(f, { selectable = false, selected = false } = {}) {
  const mv = evidenceIndex();
  const rule = (S.diagnosis?.anomalies || []).find(a => a.id === f.sourceRule);
  const facts = [...(f.facts || [])];
  if (!facts.length && rule) facts.push(rule.detail);
  const ev = (f.evidence || []).map(id => mv.get(id)).filter(Boolean);
  const interp = f.interpretation || f.description;
  const row = (k, label, body) => body ? `<div class="frow ${k}"><span class="flabel">${label}</span><div class="fbody">${body}</div></div>` : '';
  return `<article class="finding ${esc(f.level)} ${selected ? 'sel' : ''}"><div class="hd"><span class="pill ${esc(f.level)}">${E.LEVEL_LABEL[f.level]}</span><h3>${esc(f.title)}</h3><span class="mono" style="font-size:12px;color:var(--ink-3)">${esc(f.id)} · ${esc(E.catLabel(f.category))}</span></div>
  ${row('fact', 'Hechos', `${facts.length ? `<ul>${facts.map(t => `<li>${hlAmounts(t)}</li>`).join('')}</ul>` : ''}${ev.length ? `<div class="tbl-wrap evt"><table><thead><tr><th>Fecha</th><th>Movimiento ${src('pdf')}</th><th>Tipo</th><th class="n">Monto</th></tr></thead><tbody>${ev.map(m => `<tr><td class="mono">${esc(m.date)}</td><td>${esc(m.concept)}${m.origin ? ` <span class="pill neutral">${esc(m.origin)}</span>` : ''}</td><td>${esc(m.type)}</td><td class="n">${E.fmtMXN(m.amount)}</td></tr>`).join('')}</tbody></table></div>` : ''}`)}
  ${row('interp', 'Interpretación', interp ? `<p>${hlAmounts(interp)}</p>` : '')}
  ${row('hyp', 'Hipótesis', (f.hypotheses || []).length ? `<ul>${f.hypotheses.map(h => `<li>${hlAmounts(h.text)}${h.quantified ? ' <span class="pill neutral">cuantificada</span>' : ''}</li>`).join('')}</ul>` : '')}
  ${row('impact', 'Impacto posible', f.impact ? `<p>${hlAmounts(f.impact)}</p>` : '')}
  ${row('rec', 'Acción recomendada', `<p>${hlAmounts(f.recommendation || 'Sin recomendación cuantificada por datos insuficientes.')}</p>`)}
  ${row('miss', 'Datos para confirmar', f.missingData ? `<p>${hlAmounts(f.missingData)}</p>` : '')}
  ${selectable ? `<div class="row"><button class="btn sm ${selected ? '' : 'primary'}" data-act="toggle-sel" data-id="${esc(f.id)}" ${dis()}>${selected ? 'Quitar de la selección' : 'Seleccionar'}</button></div>` : ''}
  </article>`;
}

// ----- Etapa 4 -----
function stage4() {
  const props = S.diagnosis.ai.findings;
  const sel = S.selection;
  return `${head(4, 'Hallazgos prioritarios', 'Elige los hallazgos que quieres desarrollar en el reporte: al menos uno, o todos. Ordénalos por urgencia (1 = más urgente) y ajusta su nivel si lo consideras necesario. La selección es tuya: nada viene preseleccionado.')}
  <section class="panel"><div class="row" style="justify-content:space-between"><h2>Tu selección (${sel.length} de ${props.length}) ${src('user')}</h2><div class="row"><button class="btn sm" data-act="sel-all" ${dis(sel.length === props.length)}>Seleccionar todos</button><button class="btn sm ghost" data-act="sel-none" ${dis(!sel.length)}>Quitar todos</button></div></div>
    ${sel.length ? `<ol class="order">${sel.map((s, i) => { const p = props.find(f => f.id === s.id); const hy = p.hypotheses || []; return `<li><span class="rk">${i + 1}</span><div class="stack"><strong>${esc(p.title)}</strong><div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">Nivel <select id="lvl-${esc(s.id)}" data-level="${esc(s.id)}" style="width:auto">${E.LEVELS.map(l => `<option value="${l}" ${l === s.level ? 'selected' : ''}>${E.LEVEL_LABEL[l]}</option>`).join('')}</select></label>${s.level !== p.level ? `<span class="pill neutral">IA proponía ${E.LEVEL_LABEL[p.level]}</span>` : ''}</div>${hy.length ? `<div class="stack">${hy.map((h, k) => `<label class="check" style="font-size:13px"><input type="checkbox" id="hy-${esc(s.id)}-${k}" data-hyp="${esc(s.id)}|${k}" ${(s.acceptedHypotheses || []).includes(k) ? 'checked' : ''} ${h.quantified ? '' : 'disabled'}><span>Hipótesis: ${esc(h.text)} ${h.quantified ? '' : '<em style="color:var(--ink-3)">(no cuantificada; no se puede aceptar)</em>'}</span></label>`).join('')}</div>` : ''}</div><div class="row"><button class="btn sm" data-act="up" data-i="${i}" aria-label="Subir" ${dis(i === 0)}>↑</button><button class="btn sm" data-act="down" data-i="${i}" aria-label="Bajar" ${dis(i === sel.length - 1)}>↓</button><button class="btn sm ghost danger-text" data-act="toggle-sel" data-id="${esc(s.id)}" aria-label="Quitar «${esc(p.title)}» de la selección" ${dis()}>Quitar</button></div></li>`; }).join('')}</ol>` : '<p>Aún no seleccionas hallazgos.</p>'}
    <div class="actionbar"><button class="btn primary" data-act="confirm-sel" ${dis(!sel.length || S.selectionConfirmedAt)}>${S.selectionConfirmedAt ? 'Selección confirmada' : `Confirmar ${sel.length === 1 ? 'el hallazgo seleccionado' : `los ${sel.length || ''} hallazgos seleccionados`}`}</button>${S.selectionConfirmedAt ? '<button class="btn" data-go="5">Ir al reporte</button>' : ''}${!sel.length ? '<span class="status">Selecciona al menos un hallazgo.</span>' : ''}</div>
  </section>
  <section class="panel"><h2>Hallazgos propuestos ${src('ia')}</h2>${props.map(f => findingCard(f, { selectable: true, selected: sel.some(s => s.id === f.id) })).join('')}</section>`;
}

// ----- Etapa 5 -----
function stage5() {
  const r = S.report;
  return `${head(5, 'Reporte ejecutivo', 'Claude redacta el contenido con los hallazgos confirmados; las tablas, gráficos, fondos y morosidad provienen del motor.')}
  <section class="panel"><h2>Observaciones del revisor ${src('user')}</h2>
    <label class="f">Indicaciones para la redacción (opcional)<textarea id="obs" data-bind="observationsDraft" placeholder="p. ej. Enfatizar el avance de impermeabilización del edificio 2; aclarar que el pago de marzo corresponde a dos meses.">${esc(S.observationsDraft)}</textarea></label>
    ${r && (S.observationsDraft || '') !== (r.observations || '') ? '<div class="banner warn">Las observaciones cambiaron: regenera el reporte para incorporarlas. Se invalidó la aprobación y la nota.</div>' : ''}
    <div class="actionbar"><button class="btn ${r ? '' : 'primary'}" data-act="report" ${dis()}>${r ? 'Regenerar reporte' : 'Generar reporte'}</button>${r && (S.observationsDraft || '') === (r.observations || '') ? '<button class="btn primary" data-go="6">Pasar a verificación</button>' : ''}${statusFor('report')}</div>
  </section>
  ${r ? `<section class="panel"><div class="row"><h2>Vista previa</h2><span class="pill moderate">Borrador para revisión</span></div>${previewFrame()}</section>` : ''}`;
}

let previewHeight = 900;
function previewFrame() {
  return `<iframe class="doc" id="preview" title="Vista previa del reporte" style="width:100%;border:0;height:${previewHeight}px;padding:0" sandbox="allow-same-origin"></iframe>`;
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
    <div class="kpi"><span class="l">Función (elegida en la etapa 1)</span><span class="v" style="font-family:var(--f-body);font-size:15px">${esc(R().reviewer)}</span></div></div>
    <p style="font-size:12.5px;color:var(--ink-3)">Esta aprobación queda registrada con fecha y hora. No es firma electrónica ni acta de Asamblea.</p>`}
    <div class="actionbar">
      ${rv?.approvedAt ? (S.alert ? '<button class="btn primary" data-go="7">Ver nota de alerta</button>' : `<button class="btn primary" data-act="alert" ${dis()}>Generar nota de alerta</button>`) : `<button class="btn primary" data-act="approve" ${dis(!ok)}>Aprobar reporte</button>`}
      <button class="btn ghost" data-go="5" ${dis()}>Volver al reporte para pedir ajustes</button>
      ${statusFor('alert')}
      ${!rv?.approvedAt ? `<span class="status" id="rv-hint">${reviewHint()}</span>` : ''}
    </div>
  </section>`;
}

function reviewHint() {
  const d = S._review || {};
  return !(d.reviewer || '').trim() ? 'Falta el nombre del revisor.' : !(d.a && d.b && d.c) ? `Faltan ${[d.a, d.b, d.c].filter(x => !x).length} confirmación(es).` : 'Listo para aprobar.';
}
// Actualiza el botón y el aviso sin redibujar la pantalla (evita que la página salte).
function refreshReviewControls() {
  const d = S._review;
  const ok = (d.reviewer || '').trim() && d.a && d.b && d.c;
  const b = document.querySelector('[data-act="approve"]'); if (b) b.disabled = !ok || !!busy;
  const h = document.getElementById('rv-hint'); if (h) h.textContent = reviewHint();
}

// ----- Etapa 7 -----
function stage7() {
  const a = S.alert;
  return `${head(7, esc(R().note), 'Comprueba que el documento sea coherente con el reporte aprobado. Es un instrumento de apoyo: no se envía a nadie automáticamente.')}
  ${a ? `<section class="panel doc-lite"><div class="row" style="justify-content:flex-end"><button class="btn sm" data-act="mail-copy">Copiar como texto para correo</button><span class="status" id="mail-copy-status"></span></div><div class="doc" style="padding:22px">${alertBody(a.ai, S).replace('<h2>', '<h2 style="color:#23211a;margin-bottom:10px">')}</div></section>` : `<section class="panel"><p>La nota aún no se ha generado.</p></section>`}
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
      ${S.alert?.ai ? `<button class="btn" data-act="mail-copy" ${dis()}>Copiar escrito como texto para correo</button>` : ''}<span class="status" id="mail-copy-status"></span>
    </div>
    <p style="font-size:13px;color:var(--ink-2)">Para imprimir o guardar como PDF, abre el HTML descargado y usa el botón «Imprimir / Guardar PDF». La copia JSON contiene datos extraídos, mapeo, decisiones y avance, sin credenciales.</p>
    ${errors.download ? `<div class="status err">${esc(errors.download)}</div>` : ''}
  </section>
  <section class="panel">${previewFrame()}</section>
  <section class="panel"><h2>Cierre</h2>
    ${S.closedAt ? `<div class="banner ok">Análisis cerrado el ${esc(new Date(S.closedAt).toLocaleString('es-MX'))}.</div>` : '<p>Al cerrar se registra el evento. Seguirás pudiendo consultar y descargar.</p>'}
    <div class="actionbar">
      ${S.closedAt ? '' : `<button class="btn primary" data-act="close" ${dis()}>Cerrar análisis</button>`}
    </div>
  </section>`;
}

// Interrumpir el análisis actual y comenzar otro, disponible al final de cada etapa.
function abandonView() {
  const hasCase = S.files.length || S.months.length;
  if (!hasCase) return '';
  const closed = !!S.closedAt;
  return `<section class="abandon" id="abandon"><div class="abandon-row"><div class="stack"><strong>${closed ? 'Comenzar otro análisis' : '¿Ya no necesitas este análisis?'}</strong><span class="muted">${closed ? 'El análisis está cerrado. Puedes iniciar otro período.' : 'Puedes interrumpirlo en cualquier etapa y comenzar uno nuevo sin terminarlo.'}</span></div>
    <button class="btn danger" data-act="new" ${dis(S._confirmNew)}>${closed ? 'Nuevo análisis' : 'Interrumpir y comenzar nuevo análisis'}</button></div>
    ${S._confirmNew ? `<div class="banner err" role="alertdialog" aria-labelledby="ab-t"><div class="stack"><strong id="ab-t">¿Descartar el análisis actual?</strong><span>Se borrará de este navegador el análisis en curso (${S.months.length ? `${S.months.length} mes${S.months.length === 1 ? '' : 'es'} interpretado${S.months.length === 1 ? '' : 's'}` : `${S.files.length} PDF cargado${S.files.length === 1 ? '' : 's'}`}${closed ? '' : `, etapa ${S.stage} de 8`}). Si quieres conservarlo, descarga antes la copia JSON. La conexión con Claude se conserva.</span><div class="row"><button class="btn" data-act="dl-json">Descargar copia JSON</button><button class="btn danger" data-act="new-yes">Sí, descartar y empezar de nuevo</button><button class="btn ghost" data-act="new-no">Cancelar</button></div></div></div>` : ''}
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
    fr.onload = () => { try { previewHeight = fr.contentDocument.documentElement.scrollHeight + 20; fr.style.height = previewHeight + 'px'; } catch {} };
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
  if (t.dataset.scroll) { e.preventDefault(); const el = document.getElementById(t.dataset.scroll); el?.closest('details')?.setAttribute('open', ''); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); el?.querySelector('input,select,textarea')?.focus({ preventScroll: true }); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2600); } return; }
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
    case 'oop-exclude': case 'oop-keep': {
      const m = S.months.find(x => x.period === t.dataset.period);
      if (!m) return;
      const oop = E.outOfPeriod(m);
      if (act === 'oop-keep') { m.outOfPeriodDecision = 'keep'; S.corrections.push({ at: now(), period: m.period, what: `Se conservan ${oop.length} movimiento(s) con fecha fuera del período`, why: 'Decisión del usuario' }); log('fuera_de_periodo', `${m.period}: se conservan ${oop.length}`); }
      else {
        const ids = new Set(oop.map(x => x.id));
        m.excludedMovements = [...(m.excludedMovements || []), ...oop.map(x => ({ ...x, excludedAt: now(), reason: 'Fecha fuera del período' }))];
        m.movements = m.movements.filter(x => !ids.has(x.id)); m.unclassifiedMovements = m.unclassifiedMovements.filter(x => !ids.has(x.id));
        Object.assign(m, E.recomputeMonth(m));
        S.corrections.push({ at: now(), period: m.period, what: `Excluidos ${oop.length} movimiento(s) con fecha fuera del período (${[...new Set(oop.map(x => x.date))].slice(0, 4).join(', ')})`, why: 'No pertenecen al estado de cuenta del mes' });
        log('fuera_de_periodo', `${m.period}: excluidos ${oop.length}`);
      }
      invalidate('confirmation'); S.confirmation = null; save(); return render();
    }
    case 'q-obs': case 'q-dismiss': {
      const q = [...E.engineQuestions(months()), ...months().flatMap(m => m.aiQuestions || [])].find(x => x.id === t.dataset.q);
      if (!q) return;
      const text = (document.getElementById('obs-' + q.id)?.value || q.observationDraft || q.prompt).trim();
      S.qActions[q.id] = { action: act === 'q-obs' ? 'observation' : 'dismiss', text, prompt: q.prompt, period: q.period, kind: q.kind, blocking: !!q.blocking, movementId: questionMovement(q)?.id || q.movementId || null, at: now() };
      log(act === 'q-obs' ? 'observación' : 'aclaración_descartada', `${q.period}: ${act === 'q-obs' ? text : q.prompt}`.slice(0, 280));
      invalidate('confirmation'); S.confirmation = null; save(); return render();
    }
    case 'q-answer': { answerOpen.has(t.dataset.q) ? answerOpen.delete(t.dataset.q) : answerOpen.add(t.dataset.q); return render(); }
    case 'obs-remove': { delete S.qActions[t.dataset.q]; log('observación', 'Observación retirada; la aclaración vuelve a pendientes'); invalidate('confirmation'); S.confirmation = null; save(); return render(); }
    case 'dismiss-restore': { for (const [k] of dismissed()) delete S.qActions[k]; log('aclaración_descartada', 'Aclaraciones restauradas'); invalidate('confirmation'); S.confirmation = null; save(); return render(); }
    case 'mail-copy': {
      const txt = alertPlainText(S.alert.ai, S);
      const st = document.getElementById('mail-copy-status');
      try { await navigator.clipboard.writeText(txt); if (st) st.textContent = 'Texto copiado: pégalo en el cuerpo del correo y adjunta el reporte HTML.'; }
      catch { if (st) { const ta = document.createElement('textarea'); ta.value = txt; ta.rows = 10; ta.style.width = '100%'; st.replaceWith(ta); ta.select(); } }
      log('correo', 'Escrito copiado como texto');
      return;
    }
    case 'obs-copy': {
      const txt = `${R().obsPanel} — ${CONDO.name}\n\n` + observations().map((o, i) => `${i + 1}. [${o.period}] ${o.text}`).join('\n');
      const st = document.getElementById('obs-copy-status');
      try { await navigator.clipboard.writeText(txt); if (st) st.textContent = 'Lista copiada.'; }
      catch { if (st) { st.textContent = ''; const ta = document.createElement('textarea'); ta.value = txt; ta.rows = 6; ta.style.width = '100%'; st.replaceWith(ta); ta.select(); } }
      return;
    }
    case 'reread': { log('relectura', 'Volver a leer el mes para incorporar la morosidad'); await runInterpret([t.dataset.file]); S._checks = {}; save(); return render(); }
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
      else { const p = S.diagnosis.ai.findings.find(f => f.id === id); S.selection.push({ id, level: p.level, acceptedHypotheses: [] }); }
      if (S.selectionConfirmedAt || S.report) invalidate('selection');
      log('selección', S.selection.map(s => s.id).join(', ') || '(vacía)'); save(); return render();
    }
    case 'up': case 'down': {
      const i = Number(t.dataset.i), j = act === 'up' ? i - 1 : i + 1;
      [S.selection[i], S.selection[j]] = [S.selection[j], S.selection[i]];
      if (S.selectionConfirmedAt || S.report) invalidate('selection');
      log('orden', S.selection.map(s => s.id).join(' > ')); save(); return render();
    }
    case 'check-all': case 'check-none': {
      S._checks = Object.fromEntries(['currency', 'bank', 'period', 'categories', 'funds', 'arithmetic', 'continuity', 'delinquency'].map(k => [k, act === 'check-all']));
      log('confirmación', act === 'check-all' ? 'Todas las casillas marcadas' : 'Todas las casillas desmarcadas'); save(); return render();
    }
    case 'sel-all': case 'sel-none': {
      if (act === 'sel-all') { for (const p of S.diagnosis.ai.findings) if (!S.selection.some(s => s.id === p.id)) S.selection.push({ id: p.id, level: p.level, acceptedHypotheses: [] }); }
      else S.selection = [];
      if (S.selectionConfirmedAt || S.report) invalidate('selection');
      log('selección', S.selection.map(s => s.id).join(', ') || '(vacía)'); save(); return render();
    }
    case 'confirm-sel': S.selectionConfirmedAt = now(); log('selección_confirmada', S.selection.map(s => `${s.id}:${s.level}`).join(', ')); save(); return render();
    case 'report': return runReport();
    case 'approve': {
      const d = S._review;
      if (!(d.reviewer.trim() && d.a && d.b && d.c)) return;
      S.review = { reviewer: d.reviewer.trim(), role: R().reviewer, roleKey: S.role, checks: { a: true, b: true, c: true }, approvedAt: now() };
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
    case 'new': S._confirmNew = true; render(); document.getElementById('abandon')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return;
    case 'new-no': S._confirmNew = false; return render();
    case 'new-yes': { try { localStorage.removeItem(STORE_KEY); } catch {} PAGE_IMAGES.clear(); for (const k in errors) errors[k] = null; S = fresh(); log('nuevo_análisis', 'Se descartó el análisis anterior'); save(); render(); scrollMainTop(); return; }
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
  if (t.dataset.obstext && S.qActions[t.dataset.obstext]) { S.qActions[t.dataset.obstext].text = t.value; save(); }
  if (t.dataset.rvname) { S._review.reviewer = t.value; save(); refreshReviewControls(); }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'pdf-in' && t.files.length) { addFiles(t.files); t.value = ''; return; }
  if (t.id === 'json-in' && t.files[0]) {
    t.files[0].text().then(restoreJSON).then(() => { errors.restore = null; }).catch(err => { errors.restore = err.message; render(); });
    t.value = ''; return;
  }
  if (t.dataset.role) {
    S.role = t.dataset.role;
    log('rol', E.roleOf(S.role).label);
    if (S.review || S.alert) invalidate('review');
    save(); return render();
  }
  if (t.dataset.bindCheck) { S[t.dataset.bindCheck] = t.checked; log(t.dataset.bindCheck, t.checked ? 'otorgado' : 'retirado'); save(); return render(); }
  if (t.dataset.bind === 'observationsDraft' || t.dataset.bind?.startsWith('meta.')) { if (t.dataset.bind.startsWith('meta.') && confirmed()) { S.confirmation = null; invalidate('confirmation'); } save(); return render(); }
  if (t.dataset.bind) return render();
  if (t.dataset.check) { S._checks[t.dataset.check] = t.checked; save(); return render(); }
  if (t.dataset.cat) return changeMovement(t.dataset.cat, { category: t.value }, true);
  if (t.dataset.mvfund) return changeMovement(t.dataset.mvfund, { fund: t.value }, false, 'Tipo de fondo asignado por el usuario');
  if (t.dataset.origin !== undefined) return changeMovement(t.dataset.origin, { origin: E.formatOrigin(t.value) }, false, 'Origen capturado por el usuario');
  if (t.dataset.qcat && t.value) return changeMovement(t.dataset.qcat, { category: t.value }, false, 'Respuesta a aclaración');
  if ((t.dataset.amt || t.dataset.qamt) && t.value !== '') return changeMovement(t.dataset.amt || t.dataset.qamt, { amount: Math.abs(Number(t.value)) }, false, 'Monto no identificado capturado por el usuario');
  if (t.dataset.qbal && t.value !== '') { const [p, f] = t.dataset.qbal.split('|'); return changeBalance(p, f, t.value); }
  if (t.dataset.month) return changeBalance(t.dataset.month, t.dataset.field, t.value);
  if (t.dataset.fund !== undefined) { S.fundOpenings[t.dataset.fund] = t.value === '' ? undefined : Number(t.value); if (confirmed()) invalidate('confirmation'); S.confirmation = null; log('fondo', `${t.dataset.fund}: saldo previo ${t.value || 'vacío'}`); save(); return render(); }
  if (t.dataset.level) { const s = S.selection.find(x => x.id === t.dataset.level); s.level = t.value; if (S.selectionConfirmedAt || S.report) invalidate('selection'); log('nivel', `${s.id} → ${t.value}`); save(); return render(); }
  if (t.dataset.hyp) { const [id, k] = t.dataset.hyp.split('|'); const s = S.selection.find(x => x.id === id); const n = Number(k); s.acceptedHypotheses = t.checked ? [...new Set([...(s.acceptedHypotheses || []), n])] : (s.acceptedHypotheses || []).filter(x => x !== n); if (S.report) invalidate('report'); log('hipótesis', `${id}#${k} ${t.checked ? 'aceptada' : 'retirada'}`); save(); return render(); }
  if (t.dataset.rv) { S._review[t.dataset.rv] = t.checked; save(); return refreshReviewControls(); }
  if (t.dataset.rvrole) { S._review.role = t.value; save(); }
});

let pendingWhy = null;
function changeMovement(id, patch, askWhy, why = '') {
  for (const m of S.months) for (const list of ['movements', 'unclassifiedMovements']) {
    const mv = m[list].find(x => x.id === id);
    if (!mv) continue;
    const before = { category: mv.category, amount: mv.amount, fund: mv.fund, origin: mv.origin };
    Object.assign(mv, patch);
    if ('fund' in patch) mv.fundManual = true;
    else if (patch.category && !mv.fundManual) mv.fund = E.defaultFund(patch.category, mv.concept);
    const what = 'fund' in patch ? `${mv.date} «${mv.concept}»: fondo ${before.fund || E.FUND_NONE} → ${patch.fund}`
      : 'origin' in patch ? `${mv.date} «${mv.concept}»: origen ${before.origin || 'no identificado'} → ${patch.origin || 'no identificado'}`
      : patch.category ? `${mv.date} «${mv.concept}»: ${E.catLabel(before.category)} → ${E.catLabel(patch.category)}` : `${mv.date} «${mv.concept}»: monto ${E.fmtMXN(patch.amount)}`;
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

try { document.documentElement.lang = 'es'; } catch {}
render();
initAI();
