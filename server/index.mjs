// Servidor Node.js (sin dependencias) para despliegue propio con clave API de Anthropic.
// Rutas: GET /api/status · POST /api/connect · POST /api/disconnect · POST /api/ai (SSE)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrompt, validateResult, parseJsonText, AI_OPS, MAX_TOKENS } from '../lib/ai.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8787);
const SITE_ORIGIN = process.env.SITE_ORIGIN || `http://localhost:${PORT}`;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
const API = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const TIMEOUT = { interpret: 300000, origins: 180000, analyze: 180000, report: 180000, alert: 180000 };

const rawKey = process.env.SESSION_ENCRYPTION_KEY;
if (!rawKey) { console.error('Falta SESSION_ENCRYPTION_KEY (32 bytes aleatorios en base64). Genera una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'); process.exit(1); }
const ENC_KEY = Buffer.from(rawKey, 'base64');
if (ENC_KEY.length !== 32) { console.error('SESSION_ENCRYPTION_KEY debe decodificar a exactamente 32 bytes.'); process.exit(1); }
const MAC_KEY = crypto.createHmac('sha256', ENC_KEY).update('cookie-signing').digest();

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const STORE = path.join(DATA_DIR, 'keys.json');
const readStore = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } };
const writeStore = s => { fs.writeFileSync(STORE + '.tmp', JSON.stringify(s), { mode: 0o600 }); fs.renameSync(STORE + '.tmp', STORE); };

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function decrypt(rec) {
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(rec.iv, 'base64'));
  d.setAuthTag(Buffer.from(rec.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(rec.ct, 'base64')), d.final()]).toString('utf8');
}

// Identidad: si la plataforma inyecta un usuario autenticado (TRUSTED_USER_HEADER), se usa;
// si no, una cookie de sesión firmada por el servidor. Nunca un id enviado en el cuerpo.
function identity(req, res) {
  const hdr = process.env.TRUSTED_USER_HEADER;
  if (hdr && req.headers[hdr.toLowerCase()]) return 'u:' + String(req.headers[hdr.toLowerCase()]);
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]));
  const v = cookies.sid;
  if (v) {
    const [id, mac] = v.split('.');
    const ok = mac && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(crypto.createHmac('sha256', MAC_KEY).update(id).digest('base64url')));
    if (ok) return 's:' + id;
  }
  const id = crypto.randomBytes(18).toString('base64url');
  const mac = crypto.createHmac('sha256', MAC_KEY).update(id).digest('base64url');
  res.setHeader('Set-Cookie', `sid=${id}.${mac}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${SITE_ORIGIN.startsWith('https') ? '; Secure' : ''}`);
  return 's:' + id;
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const originOk = req => !req.headers.origin || req.headers.origin === SITE_ORIGIN;
async function body(req, limit = 4 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Solicitud demasiado grande'), { code: 'too_large' }); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON inválido'), { code: 'bad_request' }); }
}

function classify(status, text) {
  if (status === 401) return { code: 'key_rejected', message: 'Anthropic rechazó la clave API.' };
  if (status === 402 || status === 403) return { code: 'billing', message: 'La cuenta API no tiene saldo o permisos.' };
  if (status === 404) return { code: 'billing', message: `La clave no tiene acceso al modelo ${MODEL}.` };
  if (status === 429) return { code: 'rate_limited', message: 'Límite de uso alcanzado.' };
  if (/^\s*</.test(text || '')) return { code: 'html_response', message: 'Respuesta HTML inesperada.' };
  return { code: 'upstream_error', message: `Error ${status} de Anthropic.` };
}
const anthropicHeaders = key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });

function getKey(user) { const rec = readStore()[user]; return rec ? decrypt(rec) : null; }

async function handleConnect(req, res, user) {
  const { apiKey } = await body(req, 10000);
  if (typeof apiKey !== 'string' || !/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(apiKey)) return json(res, 400, { code: 'key_rejected', message: 'El formato de la clave no es válido.' });
  const r = await fetch(`${API}/v1/models/${encodeURIComponent(MODEL)}`, { headers: anthropicHeaders(apiKey) });
  if (!r.ok) return json(res, 400, classify(r.status, await r.text()));
  const store = readStore();
  store[user] = { ...encrypt(apiKey), savedAt: new Date().toISOString() };
  writeStore(store);
  const check = getKey(user); // lee y descifra lo persistido
  if (check !== apiKey) return json(res, 500, { code: 'store_error', message: 'No se pudo confirmar la clave guardada.' });
  console.log(JSON.stringify({ at: new Date().toISOString(), action: 'connect', user: hash(user) }));
  return json(res, 200, { authenticated: true, connected: true, model: MODEL });
}
const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

async function handleAI(req, res, user) {
  const { op, payload, images = [] } = await body(req, 60 * 1024 * 1024);
  if (!AI_OPS.includes(op) || !payload || typeof payload !== 'object') return json(res, 400, { code: 'bad_request', message: 'Operación o datos inválidos.' });
  if (!Array.isArray(images) || images.length > 20 || images.some(b => typeof b !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b) || b.length > 7_000_000)) return json(res, 400, { code: 'bad_request', message: 'Imágenes inválidas (máximo 20 JPEG por solicitud).' });
  if (images.length && !['interpret', 'origins'].includes(op)) return json(res, 400, { code: 'bad_request', message: 'Solo la interpretación admite imágenes.' });
  const key = getKey(user);
  if (!key) return json(res, 400, { code: 'not_connected', message: 'Conecta Claude primero.' });
  let prompt;
  try { prompt = buildPrompt(op, payload); } catch (e) { return json(res, 400, { code: 'bad_request', message: e.message }); }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('progress', { message: 'Solicitud enviada a Claude…', chars: 0 });
  const started = Date.now();
  let text = '', usage = { input_tokens: null, output_tokens: null }, stop = null, closed = false;
  const ctl = new AbortController();
  req.on('close', () => { closed = true; ctl.abort(); });
  const hb = setInterval(() => send('progress', { message: text ? 'Recibiendo respuesta…' : 'Claude está analizando…', chars: text.length, elapsed: Math.round((Date.now() - started) / 1000) }), 8000);
  const to = setTimeout(() => ctl.abort('timeout'), TIMEOUT[op]);
  try {
    const r = await fetch(`${API}/v1/messages`, { method: 'POST', headers: anthropicHeaders(key), signal: ctl.signal, body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS[op], stream: true, system: prompt.system, messages: [{ role: 'user', content: [...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })), { type: 'text', text: prompt.user }] }] }) });
    if (!r.ok) { const t = await r.text(); throw Object.assign(new Error(), classify(r.status, t)); }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw Object.assign(new Error(), { code: 'html_response', message: 'Respuesta HTML inesperada.' });
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = (block.match(/^data: (.*)$/m) || [])[1];
        if (!data) continue;
        const ev = JSON.parse(data);
        if (ev.type === 'message_start') usage.input_tokens = ev.message?.usage?.input_tokens ?? null;
        else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
        else if (ev.type === 'message_delta') { stop = ev.delta?.stop_reason; usage.output_tokens = ev.usage?.output_tokens ?? usage.output_tokens; }
        else if (ev.type === 'error') throw Object.assign(new Error(), { code: ev.error?.type === 'overloaded_error' ? 'upstream_error' : 'upstream_error', message: 'Error durante la generación.' });
      }
    }
    if (stop === 'max_tokens') throw Object.assign(new Error(), { code: 'truncated', message: 'Respuesta truncada por límite de salida.' });
    if (!stop) throw Object.assign(new Error(), { code: 'interrupted', message: 'La respuesta se interrumpió.' });
    validateResult(op, parseJsonText(text), payload); // validación del servidor
    console.log(JSON.stringify({ at: new Date().toISOString(), action: op, images: images.length, model: MODEL, user: hash(user), input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, ms: Date.now() - started }));
    send('result', { text, usage, model: MODEL });
  } catch (e) {
    const code = ctl.signal.aborted ? (ctl.signal.reason === 'timeout' ? 'timeout' : 'cancelled') : (e.code || 'interrupted');
    console.log(JSON.stringify({ at: new Date().toISOString(), action: op, model: MODEL, user: hash(user), error: code }));
    if (!closed) send('error', { code, message: e.message || code });
  } finally { clearInterval(hb); clearTimeout(to); res.end(); }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    const url = new URL(req.url, SITE_ORIGIN);
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && !originOk(req)) return json(res, 403, { code: 'bad_origin', message: 'Origen no permitido.' });
      const user = identity(req, res);
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { authenticated: true, connected: !!readStore()[user], model: MODEL });
      if (req.method === 'POST' && url.pathname === '/api/connect') return await handleConnect(req, res, user);
      if (req.method === 'POST' && url.pathname === '/api/disconnect') { const s = readStore(); delete s[user]; writeStore(s); return json(res, 200, { connected: false }); }
      if (req.method === 'POST' && url.pathname === '/api/ai') return await handleAI(req, res, user);
      return json(res, 404, { code: 'not_found', message: 'Ruta no encontrada.' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(ROOT, 'dist', 'index.html')));
    }
    res.writeHead(404); res.end('No encontrado');
  } catch (e) {
    if (!res.headersSent) json(res, 500, { code: e.code || 'server_error', message: e.message || 'Error del servidor' });
    else res.end();
  }
});
server.listen(PORT, () => console.log(`Servidor en ${SITE_ORIGIN} (puerto ${PORT}, modelo ${MODEL})`));
