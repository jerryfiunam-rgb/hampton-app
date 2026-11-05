// Renderizado del reporte (vista previa y HTML descargable) y gráficos SVG.
import { fmtMXN, LEVEL_LABEL, catLabel } from '../lib/condominio.mjs';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = s => String(s || '').split(/\n{2,}|\n/).filter(x => x.trim()).map(x => `<p>${esc(x)}</p>`).join('');
const fmtPct = v => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%`);

// Gráfico de evolución de saldo bancario (inicial del primer mes + finales de cada mes).
export function svgBalance(months, { accent = '#a5532a' } = {}) {
  const pts = [];
  if (months.length && months[0].initialBalance !== null) pts.push({ label: `Inicio ${months[0].period}`, short: 'Inicio', v: months[0].initialBalance });
  for (const m of months) if (m.finalBalance !== null) pts.push({ label: m.period, short: m.period.slice(2).replace('-', '/'), v: m.finalBalance });
  if (pts.length < 2) return '<p class="muted">Se necesitan al menos dos saldos para graficar la evolución.</p>';
  const W = 720, H = 260, L = 92, R = 20, T = 18, B = 40;
  const vals = pts.map(p => p.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = i => L + (i * (W - L - R)) / (pts.length - 1);
  const y = v => T + ((hi - v) * (H - T - B)) / (hi - lo);
  let grid = '';
  for (let v = lo; v <= hi + step / 2; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="currentColor" stroke-opacity=".15"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="currentColor">${esc(compact(v))}</text>`;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(pts.length - 1).toFixed(1)},${(H - B).toFixed(1)}L${x(0).toFixed(1)},${(H - B).toFixed(1)}Z`;
  const dots = pts.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${i === pts.length - 1 ? 5 : 3.5}" fill="${accent}"><title>${esc(p.label)}: ${esc(fmtMXN(p.v))}</title></circle>`).join('');
  const every = Math.ceil(pts.length / 8);
  const labels = pts.map((p, i) => (i % every === 0 || i === pts.length - 1) ? `<text x="${x(i).toFixed(1)}" y="${H - B + 18}" text-anchor="middle" font-size="11" fill="currentColor">${esc(p.short)}</text>` : '').join('');
  const lastP = pts.at(-1);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del saldo bancario"><title>Evolución del saldo bancario</title>${grid}<path d="${area}" fill="${accent}" fill-opacity=".12"/><path d="${line}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linejoin="round"/>${dots}${labels}<text x="${Math.min(x(pts.length - 1), W - R).toFixed(1)}" y="${(y(lastP.v) - 12).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="currentColor">${esc(fmtMXN(lastP.v))}</text></svg>`;
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toLocaleString('es-MX', { maximumFractionDigits: 2 })} M`;
  if (a >= 1e3) return `$${(v / 1e3).toLocaleString('es-MX', { maximumFractionDigits: 0 })} mil`;
  return `$${v.toLocaleString('es-MX', { maximumFractionDigits: 0 })}`;
}

// Composición de egresos del período: barras horizontales ordenadas.
export function svgComposition(list, { accent = '#a5532a' } = {}) {
  if (!list.length) return '<p class="muted">Sin egresos en el período.</p>';
  const items = list.slice(0, 10);
  const rest = list.slice(10).reduce((s, x) => s + x.amount, 0);
  if (rest) items.push({ label: 'Otras categorías', amount: rest, pct: null });
  const total = list.reduce((s, x) => s + x.amount, 0);
  const W = 720, rowH = 30, L = 230, R = 150, H = items.length * rowH + 10;
  const max = Math.max(...items.map(i => i.amount));
  const rows = items.map((it, i) => {
    const w = Math.max(2, ((W - L - R) * it.amount) / max);
    const yy = 5 + i * rowH;
    const p = total ? (it.amount / total) * 100 : 0;
    return `<text x="${L - 10}" y="${yy + 19}" text-anchor="end" font-size="12" fill="currentColor">${esc(it.label.replace('Egresos fijos — ', 'Fijo · ').replace('Egresos variables — ', 'Variable · '))}</text><rect x="${L}" y="${yy + 6}" width="${w.toFixed(1)}" height="18" rx="3" fill="${accent}" fill-opacity="${i === 0 ? 1 : 0.6}"><title>${esc(it.label)}: ${esc(fmtMXN(it.amount))}</title></rect><text x="${(L + w + 8).toFixed(1)}" y="${yy + 19}" font-size="12" fill="currentColor">${esc(fmtMXN(it.amount))} · ${p.toFixed(1)}%</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Composición de egresos"><title>Composición de egresos</title>${rows}</svg>`;
}

export function flowTable(ind) {
  const r = ind.months.map(m => `<tr${m.balanceCheck ? '' : ' class="flag"'}><td>${esc(m.period)}</td><td class="n">${fmtMXN(m.initialBalance)}</td><td class="n">${fmtMXN(m.totalIncome)}</td><td class="n">${fmtMXN(m.totalExpense)}</td><td class="n">${fmtMXN(m.netFlow)}</td><td class="n">${fmtMXN(m.finalBalance)}</td><td class="n">${m.balanceCheck ? 'Cuadra' : `Dif. ${fmtMXN(m.balanceDiff)}`}</td><td class="n">${fmtPct(m.incomeChangePct)}</td><td class="n">${fmtPct(m.expenseChangePct)}</td><td class="n">${fmtPct(m.collectionRatePct)}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr><th>Mes</th><th class="n">Saldo inicial</th><th class="n">Ingresos</th><th class="n">Egresos</th><th class="n">Flujo neto</th><th class="n">Saldo final</th><th class="n">Cuadre</th><th class="n">Var. ingresos</th><th class="n">Var. egresos</th><th class="n">Recaudación</th></tr></thead><tbody>${r}</tbody></table></div>`;
}

export function fundsTable(ind) {
  if (!ind.funds.length) return '<p>No se identificaron fondos especiales en los movimientos confirmados.</p>';
  const r = ind.funds.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.buildingOrScope || '—')}</td><td class="n">${fmtMXN(f.opening)}</td><td class="n">${fmtMXN(f.amountCollected)}</td><td class="n">${fmtMXN(f.amountPaid)}</td><td class="n">${fmtMXN(f.balance)}</td><td>${esc(f.lastUpdated || '—')}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr><th>Fondo</th><th>Alcance</th><th class="n">Saldo previo</th><th class="n">Recaudado</th><th class="n">Aplicado</th><th class="n">Saldo</th><th>Última act.</th></tr></thead><tbody>${r}</tbody></table></div>`;
}

export function kpiGrid(ind) {
  const k = (l, v) => `<div class="kpi"><span class="l">${esc(l)}</span><span class="v">${v}</span></div>`;
  return `<div class="kpis">${[
    k('Saldo bancario al cierre', fmtMXN(ind.bankBalance)),
    k('Fondo comprometido', `${fmtMXN(ind.committedFunds)}${ind.committedPct !== null ? ` · ${fmtPct(ind.committedPct)}` : ''}`),
    k('Saldo libre de disposición', fmtMXN(ind.freeBalance)),
    k('Meses de operación cubiertos', ind.monthsCovered === null ? '—' : ind.monthsCovered.toLocaleString('es-MX', { maximumFractionDigits: 1 })),
    k('Egreso ordinario promedio', fmtMXN(ind.avgOrdinaryExpense)),
    k('Índice de morosidad', ind.delinquencyIndexPct === null ? 'Sin datos' : fmtPct(ind.delinquencyIndexPct)),
  ].join('')}</div>`;
}

const DOC_CSS = `
body{font-family:"Instrument Sans","Segoe UI",system-ui,sans-serif;color:#23211a;background:#fff;margin:0;line-height:1.55;font-size:14.5px}
.page{max-width:900px;margin:0 auto;padding:36px 28px 60px}
h1,h2,h3{font-family:"Instrument Sans","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em;color:#23211a}
h1{font-family:"Cinzel",Georgia,serif;font-weight:700;letter-spacing:.02em}
.dochead{display:flex;gap:16px;align-items:center;margin-bottom:6px}.dochead img{flex:none;height:auto}
h1{font-size:26px;margin:4px 0 10px}h2{font-size:18px;margin:30px 0 10px;padding-bottom:6px;border-bottom:2px solid #23211a}h3{font-size:15px;margin:0}
p{margin:0 0 10px}.eyebrow{font:600 11px/1.2 "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#7f3c1b}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 18px;font-size:13px;margin:14px 0;padding:12px 14px;background:#f4efe6;border-radius:8px}
.meta b{display:block;font-size:11px;color:#7b7363;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0 12px}th,td{border-bottom:1px solid #e2d8c7;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f4efe6;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5f5d52}td.n,th.n{text-align:right;white-space:nowrap;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
tr.flag td{background:#fff1f1}.tbl-wrap{overflow-x:auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:8px 0 14px}.kpi{border:1px solid #e2d8c7;border-radius:8px;padding:10px}.kpi .l{display:block;font-size:11.5px;color:#7b7363}.kpi .v{font-family:"IBM Plex Mono",monospace;font-size:15px}
.chart{width:100%;height:auto;color:#4f4a3e;margin:6px 0 14px}
.finding{border:1px solid #e2d8c7;border-left:4px solid #888;border-radius:8px;padding:12px 14px;margin:10px 0}.finding.critical{border-left-color:#d64545}.finding.moderate{border-left-color:#d08a12}.finding.observation{border-left-color:#3d78d8}
.pill{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px;margin-left:6px}.pill.critical{background:#fde3e3;color:#a62626}.pill.moderate{background:#fdf0d6;color:#8a5b07}.pill.observation{background:#e2ecfd;color:#2a5bb0}
.src{font:600 9.5px "IBM Plex Mono",monospace;letter-spacing:.06em;text-transform:uppercase;border:1px solid currentColor;border-radius:4px;padding:0 5px;vertical-align:1px}.src.pdf{color:#7b4fc9}.src.motor{color:#0f7f93}.src.user{color:#a66b00}.src.ia{color:#7f3c1b}
.note{border:1px solid #d8ccb8;border-radius:10px;padding:18px 20px;background:#fffdf9}.muted{color:#7b7363;font-size:12.5px}
.approval{border:1px dashed #7f3c1b;border-radius:8px;padding:10px 14px;background:#f3f5ea;font-size:13px}
.printbar{position:sticky;top:0;background:#23211a;color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:space-between;font-size:13px}
.printbar button{background:#a5532a;border:0;color:#fffaf3;font-weight:700;padding:8px 14px;border-radius:6px;cursor:pointer}
@media print{.printbar{display:none}.page{padding:0}h2{break-after:avoid}.finding,.note,table{break-inside:avoid}}
`;

// Cuerpo del reporte (compartido por la vista previa y el HTML descargable).
export function reportBody(S, ind, { includeNote = false, logo = '' } = {}) {
  const R = S.report?.ai || {};
  const sel = S.selection || [];
  const props = S.diagnosis?.ai?.findings || [];
  const movIndex = new Map();
  for (const m of S.months) for (const mv of [...m.movements, ...m.unclassifiedMovements]) movIndex.set(mv.id, mv);
  const findings = sel.map((s, i) => {
    const p = props.find(f => f.id === s.id) || {};
    const r = (R.findings || []).find(f => f.id === s.id) || {};
    const ev = (p.evidence || []).map(id => movIndex.get(id)).filter(Boolean);
    const hyps = (p.hypotheses || []).filter((_, k) => (s.acceptedHypotheses || []).includes(k));
    return `<div class="finding ${esc(s.level)}"><h3>${i + 1}. ${esc(r.title || p.title)} <span class="pill ${esc(s.level)}">${LEVEL_LABEL[s.level]}</span> <span class="muted">(${esc(s.id)} · ${esc(catLabel(p.category))})</span></h3>
      ${para(r.narrative || p.description)}
      <p><b>Evidencia</b> <span class="src pdf">PDF</span></p>
      <div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Tipo</th><th class="n">Monto</th></tr></thead><tbody>${ev.map(m => `<tr><td>${esc(m.date)}</td><td>${esc(m.concept)}</td><td>${esc(m.type)}</td><td class="n">${fmtMXN(m.amount)}</td></tr>`).join('')}</tbody></table></div>
      ${r.evidenceSummary ? para(r.evidenceSummary) : ''}
      ${hyps.length ? `<p><b>Hipótesis aceptadas por el revisor</b> <span class="src user">Usuario</span></p><ul>${hyps.map(h => `<li>${esc(h.text)}</li>`).join('')}</ul>` : ''}
      <p><b>Recomendación</b> <span class="src ia">IA</span></p>${para(r.recommendation || p.recommendation || 'Sin recomendación cuantificada: los datos son insuficientes.')}
      ${(r.missingData || p.missingData) ? `<p class="muted"><b>Datos adicionales necesarios:</b> ${esc(r.missingData || p.missingData)}</p>` : ''}</div>`;
  }).join('');
  const rv = S.review;
  const note = S.alert?.ai;
  return `
  <div class="dochead">${logo ? `<img src="${logo}" alt="Escudo del Condominio Hampton Court" width="72" height="73">` : ''}<div><div class="eyebrow">Análisis de estados de cuenta</div>
  <h1>Reporte ejecutivo — ${esc(S.condo.name)}</h1></div></div>
  <div class="meta"><div><b>Condominio</b>${esc(S.condo.name)}</div><div><b>Período</b>${esc(ind.periodFrom)}${ind.periodTo !== ind.periodFrom ? ` a ${esc(ind.periodTo)}` : ''}</div><div><b>Fecha de análisis</b>${esc((S.report?.at || '').slice(0, 10))}</div><div><b>Dirección</b>${esc(S.condo.address || '')}</div><div><b>Banco</b>${esc(S.meta.bank || 'No indicado')} · ${esc(S.meta.currency || 'MXN')}</div><div><b>Revisor</b>${rv?.approvedAt ? esc(rv.reviewer) : 'Pendiente'}</div></div>
  <p class="muted">Fuentes: <span class="src pdf">PDF</span> dato extraído del estado de cuenta · <span class="src motor">Motor</span> cálculo reproducible · <span class="src user">Usuario</span> anotación del revisor · <span class="src ia">IA</span> análisis redactado por Claude.</p>
  ${S.report?.status !== 'final' && !rv?.approvedAt ? '<p><span class="pill moderate">Borrador para revisión</span></p>' : ''}
  <h2>Resumen ejecutivo <span class="src ia">IA</span></h2>${para(R.executiveSummary)}
  <h2>Flujo de fondos mensual <span class="src motor">Motor</span></h2>
  ${kpiGrid(ind)}
  ${flowTable(ind)}
  ${svgBalance(ind.months, { accent: '#a5532a' })}
  ${para(R.flowAnalysis)}
  <h2>Análisis de egresos <span class="src motor">Motor</span> <span class="src ia">IA</span></h2>
  ${svgComposition(ind.composition, { accent: '#a5532a' })}
  ${ind.categoryChanges.filter(c => c.flagged).length ? `<div class="tbl-wrap"><table><thead><tr><th>Categoría</th><th>Meses</th><th class="n">Anterior</th><th class="n">Actual</th><th class="n">Variación</th></tr></thead><tbody>${ind.categoryChanges.filter(c => c.flagged).map(c => `<tr><td>${esc(c.label)}</td><td>${esc(c.from)} → ${esc(c.to)}</td><td class="n">${fmtMXN(c.prev)}</td><td class="n">${fmtMXN(c.cur)}</td><td class="n">${fmtPct(c.changePct)}</td></tr>`).join('')}</tbody></table></div><p class="muted">Variaciones mensuales mayores a 20%.</p>` : ''}
  ${para(R.expenseAnalysis)}
  <h2>Estado de fondos especiales <span class="src motor">Motor</span></h2>
  ${fundsTable(ind)}
  ${para(R.fundsAnalysis)}
  <h2>Estado de morosidad</h2>
  ${ind.delinquentDebt !== null ? `<p><span class="src user">Usuario</span> Deuda morosa declarada: ${fmtMXN(ind.delinquentDebt)}. <span class="src motor">Motor</span> Índice de morosidad: ${fmtPct(ind.delinquencyIndexPct)} de los ingresos ordinarios anualizados (${fmtMXN(ind.annualizedOrdinaryIncome)}).</p>` : '<p>Los estados de cuenta no contienen datos de morosidad por condómino y no se proporcionaron; no se calcula índice de morosidad.</p>'}
  ${para(R.delinquencyAnalysis)}
  <h2>Hallazgos prioritarios</h2>${findings}
  ${S.report?.observations ? `<h2>Observaciones del revisor <span class="src user">Usuario</span></h2>${para(S.report.observations)}` : ''}
  <h2>Limitaciones del análisis</h2>${para(R.limitations)}
  ${rv?.approvedAt ? `<div class="approval"><b>Revisión humana:</b> aprobado por ${esc(rv.reviewer)} (${esc(rv.role)}) el ${esc(new Date(rv.approvedAt).toLocaleString('es-MX'))}. Confirmó cifras y cuadre, evidencia de hallazgos y coherencia de recomendaciones. Esta aprobación no es firma electrónica ni acta de Asamblea.</div>` : ''}
  ${includeNote && note ? alertBody(note, S) : ''}`;
}

export function alertBody(n, S) {
  return `<h2>Nota de alerta para el Comité de Vigilancia <span class="src ia">IA</span></h2>
  <div class="note">
    <p><b>Para:</b> ${esc(n.addressee)}<br><b>De:</b> ${esc(n.sender)}<br><b>Referencia:</b> ${esc(n.reference)}<br><b>Fecha:</b> ${esc(n.date)}</p>
    ${para(n.body)}
    <h3>Hallazgos por orden de urgencia</h3>
    <ol>${(n.findings || []).map(f => `<li><b>${esc(f.title)}</b> <span class="pill ${esc((S.selection.find(s => s.id === f.id) || {}).level || f.level)}">${LEVEL_LABEL[(S.selection.find(s => s.id === f.id) || {}).level || f.level] || ''}</span><br>${esc(f.risk || '')}${f.requiredAction ? `<br><b>Acción requerida:</b> ${esc(f.requiredAction)}` : ''}${f.suggestedDeadline ? ` <b>Plazo sugerido:</b> ${esc(f.suggestedDeadline)}` : ''}</li>`).join('')}</ol>
    <h3>Preguntas para el administrador en la próxima reunión</h3>
    <ol>${(n.questionsForCommittee || []).map(q => `<li>${esc(q)}</li>`).join('')}</ol>
    ${para(n.legalWarning)}
    <p class="muted">Instrumento de apoyo interno. No se envía automáticamente ni ejecuta acciones externas.</p>
  </div>`;
}

export function standaloneReport(S, ind, { preview = false, logo = '' } = {}) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=IBM+Plex+Mono:wght@400;600&family=Instrument+Sans:wght@400;600&display=swap"><title>Reporte ${esc(S.condo.name)} ${esc(ind.periodFrom)}–${esc(ind.periodTo)}</title><style>${DOC_CSS}</style></head><body>${preview ? '' : `<div class="printbar"><span>Reporte ejecutivo condominial · ${esc(S.condo.name)}</span><button onclick="window.print()">Imprimir / Guardar PDF</button></div>`}<div class="page">${reportBody(S, ind, { includeNote: !preview || !!S.alert?.acceptedAt, logo })}<p class="muted" style="margin-top:28px">Generado con Condominio / Análisis de estados de cuenta — Workflow con IA. Caso ${esc(S.caseId)}. Cierre: ${S.closedAt ? esc(new Date(S.closedAt).toLocaleString('es-MX')) : 'pendiente'}.</p></div></body></html>`;
}
