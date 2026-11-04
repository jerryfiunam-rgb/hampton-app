// Construcción reproducible: empaqueta los módulos en un único HTML sin dependencias de build.
// Salidas: dist/hampton.html (fragmento para claude.ai Artifact) y dist/index.html (documento para el servidor Node).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODULES = ['lib/condominio.mjs', 'lib/pdf-parser.mjs', 'lib/ai.mjs', 'web/report.mjs', 'web/app.js'];
const varName = p => '__m_' + path.basename(p).replace(/\W/g, '_');

function transform(file) {
  let src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const exportsList = [];
  src = src.replace(/^import \* as (\w+) from '([^']+)';$/gm, (_, ns, from) => `const ${ns} = ${varName(path.join(path.dirname(file), from))};`);
  src = src.replace(/^import \{([^}]+)\} from '([^']+)';$/gm, (_, names, from) => `const {${names}} = ${varName(path.join(path.dirname(file), from))};`);
  src = src.replace(/^export (async function|function|const|let) (\w+)/gm, (_, kw, name) => { exportsList.push(name); return `${kw} ${name}`; });
  if (/^\s*(import|export)\s/m.test(src)) throw new Error(`Sintaxis de módulo no soportada en ${file}`);
  return `const ${varName(file)} = (() => {\n${src}\nreturn { ${exportsList.join(', ')} };\n})();`;
}

const bundle = MODULES.map(transform).join('\n\n');
const css = fs.readFileSync(path.join(ROOT, 'web/styles.css'), 'utf8');
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';

const fragment = `<title>Hampton Court · Estados de cuenta</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="Condominio / Análisis de estados de cuenta — Workflow con IA">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600&display=swap">
<style>
${css}
</style>
<div id="app"><p style="padding:24px">Cargando aplicación…</p></div>
<script src="${PDFJS}/pdf.min.js"></script>
<script src="${PDFJS}/pdf.worker.min.js"></script>
<script>
if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = '${PDFJS}/pdf.worker.min.js';
</script>
<script type="module">
${bundle}
</script>
`;

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dist/hampton.html'), fragment);
fs.writeFileSync(path.join(ROOT, 'dist/index.html'), `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>\n${fragment}</body></html>\n`);
console.log(`dist/hampton.html ${(fragment.length / 1024).toFixed(1)} KB`);
