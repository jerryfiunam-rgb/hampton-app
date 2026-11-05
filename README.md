# hampton-app

Aplicación web de análisis financiero del condominio Hampton Court.

Versión publicada (privada): https://claude.ai/artifact/Qft2WaWBp3p2w24KWBpxHj

## Condominio / Análisis de estados de cuenta — Workflow con IA

Aplicación web en español de 8 etapas: carga de PDFs → confirmación de datos → diagnóstico → hallazgos → reporte → verificación humana → nota de alerta → entrega.

## Estructura
| Ruta | Función |
|---|---|
| `lib/condominio.mjs` | Motor condominial: categorías (8.1), indicadores (8.2), reglas de anomalías (8.3), cuadre, continuidad, validación de contratos |
| `lib/pdf-parser.mjs` | Agrupación de texto de PDF.js por posición, límites (20 MB / 100 pág. / 12 archivos), detección de período |
| `lib/ai.mjs` | Instrucción común, prompts por operación (interpret, analyze, report, alert) y validación estricta de resultados |
| `web/` | Interfaz (app.js), reporte y gráficos SVG (report.mjs), estilos |
| `server/index.mjs` | Servidor Node sin dependencias: `/api/status`, `/api/connect`, `/api/disconnect`, `/api/ai` (SSE) |
| `scripts/build.mjs` | Empaqueta todo en `dist/hampton.html` (Artifact de claude.ai) y `dist/index.html` (servidor) |
| `tests/` | Pruebas del motor (`node --test tests/*.test.mjs`) y recorrido E2E con proveedor **simulado** (`tests/e2e.mjs`) |

## Dos formas de ejecutar
1. **Publicada en claude.ai (Artifact)**: usa Claude con la sesión de claude.ai del usuario (capacidad `sample`), sin clave API. Las descargas usan la capacidad `downloads`.
2. **Servidor propio con clave API de Anthropic**:
   ```bash
   node scripts/build.mjs
   export SESSION_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
   export SITE_ORIGIN=https://tu-dominio.example ANTHROPIC_MODEL=claude-sonnet-4-6 PORT=8787
   node server/index.mjs
   ```
   La clave se cifra con AES-256-GCM (IV aleatorio por escritura) en `DATA_DIR/keys.json`, se lee y descifra tras guardarla. Identidad: cabecera `TRUSTED_USER_HEADER` de la plataforma si existe; si no, cookie de sesión firmada por el servidor. Los logs registran acción, modelo, tokens y hora; nunca claves ni contenido de PDFs.

## Supuestos declarados
- Tiempo máximo: 3 min para analyze/report/alert; 5 min para interpret (un estado de cuenta largo genera mucha salida).
- Datos del condominio fijos en `web/app.js` (`CONDO`): Condominio Hampton Court, Mar de la Tranquilidad 35, Col. Los Olivos, Coyoacán, CDMX, 80 departamentos. Sin cuota ordinaria ni deuda morosa capturadas, la tasa de recaudación y el índice de morosidad no se calculan.
- PDFs de texto, escaneados o mixtos: cada página con poco texto (o con imágenes y poco texto) se renderiza a JPEG en el navegador y Claude la lee como imagen. Las imágenes viven solo en memoria: tras recargar, hay que volver a cargar el PDF para reinterpretar páginas escaneadas. Los movimientos leídos de imagen se marcan «Escaneado» para verificación.
- Identidad visual tomada del escudo del condominio (`web/assets/`), tema claro.
- Respuestas de categoría/monto en aclaraciones se aplican con el motor; respuestas de texto exigen reinterpretar el mes con Claude y volver a confirmar.
- En claude.ai no se informan tokens a la página: el registro muestra una estimación (caracteres ÷ 4) marcada con *.
- El servidor valida JSON con esquema propio (`validateResult`) en lugar de depender de salidas estructuradas de la API.

## Pruebas
- `node --test tests/*.test.mjs`: 13 pruebas de aceptación del motor (cuadre $1,000, continuidad $2,000, categorización, duplicado, honorarios, etc.).
- `python3 tests/make_fixtures.py tests/fixtures` + `node tests/e2e.mjs <pdfjs-dist/build> <carpeta>`: recorrido completo con PDFs **sintéticos** y Claude **simulado**. No sustituye la validación con Claude real.
