// Renderizado del reporte (vista previa y HTML descargable) y gráficos SVG.
import { fmtMXN, LEVEL_LABEL, catLabel, roleOf } from '../lib/condominio.mjs';

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
  const all = [...(ind.adminFund ? [ind.adminFund] : []), ...ind.funds];
  if (!all.length) return '<p>No se identificaron fondos en los movimientos confirmados.</p>';
  const r = all.map(f => `<tr><td>${esc(f.name)}${f.operational ? ' (operativo)' : ''}</td><td>${esc(f.buildingOrScope || '—')}</td><td class="n">${fmtMXN(f.opening)}</td><td class="n">${fmtMXN(f.amountCollected)}</td><td class="n">${fmtMXN(f.amountPaid)}</td><td class="n">${fmtMXN(f.balance)}</td><td>${esc(f.lastUpdated || '—')}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table><thead><tr><th>Fondo</th><th>Alcance</th><th class="n">Saldo previo</th><th class="n">Recaudado</th><th class="n">Aplicado</th><th class="n">Saldo</th><th>Última act.</th></tr></thead><tbody>${r}</tbody></table></div>`;
}

export function kpiGrid(ind) {
  const k = (l, v, sub = '', warn = '') => `<div class="kpi"><span class="l">${esc(l)}</span><span class="v">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}${warn ? `<span class="s w">${warn}</span>` : ''}</div>`;
  const n = ind.months.length;
  const noOpening = ind.funds.filter(f => !f.opening).length;
  const meses = v => `${v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${v === 1 ? 'mes' : 'meses'}`;
  return `<div class="kpis kpis-6">${[
    k('Saldo bancario al cierre', fmtMXN(ind.bankBalance), `Saldo final de ${esc(ind.periodTo || '—')} según el estado de cuenta.`),
    k('Fondo comprometido', `${fmtMXN(ind.committedFunds)}${ind.committedPct !== null ? ` · ${fmtPct(ind.committedPct)}` : ''}`, 'Saldos de los fondos especiales (reserva, impermeabilización, canaletas, anticipos). No incluye el Fondo de Administración y Mantenimiento.',
      noOpening ? `${noOpening} fondo(s) especial(es) sin saldo previo capturado: si ya tenían saldo antes del período, este monto está subestimado.` : ''),
    k('Saldo libre de disposición', fmtMXN(ind.freeBalance), 'Saldo bancario al cierre − fondo comprometido.'),
    k('Cobertura del saldo libre', ind.monthsCovered === null ? '—' : meses(ind.monthsCovered),
      ind.monthsCovered === null ? 'Sin datos suficientes para calcularla.' : `Meses de gasto ordinario que el saldo libre cubriría sin nuevos ingresos: ${fmtMXN(ind.freeBalance)} ÷ ${fmtMXN(ind.avgOrdinaryExpense)}. No es el número de meses analizados.`,
      n === 1 ? 'El promedio de gasto se basa en un solo mes; tómalo como referencia.' : ''),
    k('Egreso ordinario promedio', fmtMXN(ind.avgOrdinaryExpense), `Promedio mensual de ${n} ${n === 1 ? 'mes' : 'meses'} analizado${n === 1 ? '' : 's'}, sin impermeabilización, canaletas ni traspasos entre fondos.`),
    k('Índice de morosidad', ind.delinquencyIndexPct === null ? 'Sin datos' : fmtPct(ind.delinquencyIndexPct), ind.delinquencyIndexPct === null ? 'Requiere el reporte de morosidad del estado de cuenta.' : 'Adeudo total ÷ ingresos ordinarios anualizados.'),
  ].join('')}</div>`;
}

const DOC_CSS = `
body{font-family:"Instrument Sans","Segoe UI",system-ui,sans-serif;color:#23211a;background:#fff;margin:0;line-height:1.55;font-size:14.5px}
.page{max-width:900px;margin:0 auto;padding:36px 28px 60px}
h1,h2,h3{font-family:"Instrument Sans","Segoe UI",system-ui,sans-serif;letter-spacing:-.01em;color:#23211a}
h1{font-family:"Cinzel",Georgia,serif;font-weight:700;letter-spacing:.02em}
.dochead{display:flex;gap:16px;align-items:center;margin-bottom:6px}.dochead img{flex:none;height:auto}
h1{font-size:26px;margin:4px 0 10px}h2{font-size:18px;margin:30px 0 10px;padding-bottom:6px;border-bottom:2px solid #23211a}h3{font-size:15px;margin:0}
p{margin:0 0 10px;text-align:justify;hyphens:auto}li{text-align:justify;hyphens:auto}.eyebrow{font:600 11px/1.2 "IBM Plex Mono",monospace;letter-spacing:.14em;text-transform:uppercase;color:#7f3c1b}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 18px;font-size:13px;margin:14px 0;padding:12px 14px;background:#f4efe6;border-radius:8px}
.meta b{display:block;font-size:11px;color:#7b7363;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin:6px 0 12px}th,td{border-bottom:1px solid #e2d8c7;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f4efe6;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5f5d52}td.n,th.n{text-align:right;white-space:nowrap;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
tr.flag td{background:#fff1f1}.tbl-wrap{overflow-x:auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:8px 0 14px}.kpi{border:1px solid #e2d8c7;border-radius:8px;padding:10px}.kpi .l{display:block;font-size:11.5px;color:#7b7363}.kpi .s{display:block;font-size:11px;color:#7b7363;margin-top:4px;line-height:1.4}.kpi .s.w{color:#8a5b07}.kpis-6{grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))}.kpi .v{font-family:"IBM Plex Mono",monospace;font-size:15px}
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
  for (const m of S.months) for (const r of (m.delinquency?.rows || [])) movIndex.set(r.id, { date: m.delinquency.asOf || m.period, concept: `Adeudo ${r.unit}${r.months ? ` (${r.months} meses)` : ''}`, type: 'morosidad', amount: r.amount });
  const findings = sel.map((s, i) => {
    const p = props.find(f => f.id === s.id) || {};
    const r = (R.findings || []).find(f => f.id === s.id) || {};
    const ev = (p.evidence || []).map(id => movIndex.get(id)).filter(Boolean);
    const hyps = (p.hypotheses || []).filter((_, k) => (s.acceptedHypotheses || []).includes(k));
    return `<div class="finding ${esc(s.level)}"><h3>${i + 1}. ${esc(r.title || p.title)} <span class="pill ${esc(s.level)}">${LEVEL_LABEL[s.level]}</span> <span class="muted">(${esc(s.id)} · ${esc(catLabel(p.category))})</span></h3>
      ${para(r.narrative || p.description)}
      <p><b>Evidencia</b> <span class="src pdf">PDF</span></p>
      <div class="tbl-wrap"><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Tipo</th><th class="n">Monto</th></tr></thead><tbody>${ev.map(m => `<tr><td>${esc(m.date)}</td><td>${esc(m.concept)}${m.origin ? ` (${esc(m.origin)})` : ''}</td><td>${esc(m.type)}</td><td class="n">${fmtMXN(m.amount)}</td></tr>`).join('')}</tbody></table></div>
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
  <h2>Estado de fondos <span class="src motor">Motor</span></h2>
  <p class="muted">El Fondo de Administración y Mantenimiento es el fondo operativo (ingresos ordinarios) y no forma parte del fondo comprometido.</p>
  ${fundsTable(ind)}
  ${para(R.fundsAnalysis)}
  <h2>Estado de morosidad por departamento <span class="src pdf">PDF</span> <span class="src motor">Motor</span></h2>
  ${delinquencySection(ind)}
  ${para(R.delinquencyAnalysis)}
  <h2>Hallazgos prioritarios</h2>${findings}
  ${S.report?.observations ? `<h2>Observaciones del revisor <span class="src user">Usuario</span></h2>${para(S.report.observations)}` : ''}
  ${observationsSection(S)}
  <h2>Limitaciones del análisis</h2>${para(R.limitations)}
  ${rv?.approvedAt ? `<div class="approval"><b>Revisión humana:</b> aprobado por ${esc(rv.reviewer)} (${esc(rv.role)}) el ${esc(new Date(rv.approvedAt).toLocaleString('es-MX'))}. Confirmó cifras y cuadre, evidencia de hallazgos y coherencia de recomendaciones. Esta aprobación no es firma electrónica ni acta de Asamblea.</div>` : ''}
  ${includeNote && note ? alertBody(note, S) : ''}`;
}

function delinquencySection(ind) {
  const D = ind.delinquency;
  if (!D || !D.perMonth.length) return '<p>Los estados de cuenta analizados no incluyen un reporte de morosidad leído; no se calcula el estado de morosidad.</p>';
  const units = D.units.filter(u => u.current > 0 || u.previous > 0);
  return `<div class="kpis"><div class="kpi"><span class="l">Adeudo total al ${esc(D.latestPeriod)}</span><span class="v">${fmtMXN(D.latestTotal)}</span></div><div class="kpi"><span class="l">Departamentos con adeudo</span><span class="v">${D.unitsOwing}${D.unitsPct !== null ? ` (${fmtPct(D.unitsPct)})` : ''}</span></div><div class="kpi"><span class="l">Con 3 meses o más</span><span class="v">${D.oldDebtUnits.length}</span></div><div class="kpi"><span class="l">Índice de morosidad</span><span class="v">${ind.delinquencyIndexPct === null ? '—' : fmtPct(ind.delinquencyIndexPct)}</span></div></div>
  ${D.missingPeriods.length ? `<p class="muted">Sin reporte de morosidad en: ${D.missingPeriods.map(esc).join(', ')}.</p>` : ''}
  <div class="tbl-wrap"><table><thead><tr><th>Departamento</th>${D.periods.map(p => `<th class="n">${esc(p)}</th>`).join('')}<th class="n">Meses</th><th>Tendencia</th></tr></thead><tbody>${units.map(u => `<tr${Number(u.monthsOwed) >= 3 && u.current > 0 ? ' class="flag"' : ''}><td>${esc(u.unit)}</td>${D.periods.map(p => `<td class="n">${p in u.amounts ? fmtMXN(u.amounts[p]) : '—'}</td>`).join('')}<td class="n">${u.monthsOwed ?? '—'}</td><td>${esc(u.status)}</td></tr>`).join('')}
  <tr><td><b>Total</b></td>${D.perMonth.map(p => `<td class="n"><b>${fmtMXN(p.total)}</b></td>`).join('')}<td></td><td></td></tr></tbody></table></div>
  <p class="muted">Filas resaltadas: adeudo de 3 meses o más en el último corte. Índice de morosidad = adeudo total ÷ ingresos ordinarios anualizados × 100.</p>`;
}

function observationsSection(S) {
  const obs = Object.values(S.qActions || {}).filter(a => a.action === 'observation');
  if (!obs.length) return '';
  return `<h2>${esc(roleOf(S.role).obsPanel)} <span class="src user">Usuario</span></h2><ol>${obs.map(o => `<li>[${esc(o.period)}] ${esc(o.text)}</li>`).join('')}</ol>`;
}

// Escrito final con formato de correo: encabezado, secciones numeradas, hallazgos en tarjetas,
// preguntas en recuadro, advertencia resaltada y firma. Estilos propios (fondo claro) para la app y el HTML descargable.
const MAIL_CSS = `
.mail{border:1px solid #d8ccb8;border-radius:12px;background:#fffdf9;color:#23211a;overflow:hidden;font-size:14.5px;line-height:1.6;margin:8px 0 16px}
.mail-h{background:#f4efe6;border-bottom:1px solid #d8ccb8;padding:16px 20px}
.mail-kind{font:600 11px/1.2 "IBM Plex Mono",monospace;letter-spacing:.12em;text-transform:uppercase;color:#7f3c1b;margin-bottom:10px}
.mail-meta{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}
.mail-meta dt{font-size:12px;font-weight:600;color:#7b7363;text-transform:uppercase;letter-spacing:.06em;padding-top:2px}
.mail-meta dd{margin:0;font-weight:500;overflow-wrap:anywhere}
.mail-meta .subj{font-weight:700;font-size:15.5px}
.mail-b{padding:18px 20px;display:grid;gap:18px}
.mail-sec h4{display:flex;align-items:center;gap:10px;margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7f3c1b;border-bottom:1px solid #e2d8c7;padding-bottom:6px}
.mail-sec h4 .n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#a5532a;color:#fffaf3;font:600 12px "IBM Plex Mono",monospace;letter-spacing:0}
.mail-sec p{margin:0 0 10px;text-align:justify;hyphens:auto}
.mail-amt{font-family:"IBM Plex Mono",monospace;font-size:.94em;white-space:nowrap}
.mf{border:1px solid #e2d8c7;border-left:4px solid #888;border-radius:8px;padding:10px 14px;margin:0 0 10px;background:#fff}
.mf.critical{border-left-color:#b3261e}.mf.moderate{border-left-color:#c48000}.mf.observation{border-left-color:#2f5f8a}
.mf-t{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:700;margin-bottom:6px}
.mf-t .k{font-family:"IBM Plex Mono",monospace;color:#7b7363;font-weight:600}
.mf dl{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;margin:0;font-size:13.5px}
.mf dt{color:#7b7363;font-weight:600}
.mf dd{margin:0;text-align:justify;hyphens:auto}
.mf .due{display:inline-block;background:#fdf0d6;color:#8a5b07;border-radius:999px;padding:0 9px;font-weight:600;font-size:12.5px}
.mpill{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px}
.mpill.critical{background:#fde3e3;color:#a62626}.mpill.moderate{background:#fdf0d6;color:#8a5b07}.mpill.observation{background:#e2ecfd;color:#2a5bb0}
.mail-list{margin:0;padding-left:22px;display:grid;gap:6px}
.mail-q{background:#f3f5ea;border:1px solid #cdd8b4;border-radius:8px;padding:10px 14px 10px 10px}
.mail-q .mail-list{gap:8px}
.mail-warn{border:1px solid #e8c48a;background:#fdf6e7;border-radius:8px;padding:12px 14px;display:grid;gap:4px}
.mail-warn strong{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a5b07}
.mail-warn p{margin:0;text-align:justify}
.mail-sign{border-top:1px dashed #d8ccb8;padding-top:12px}
.mail-sign b{display:block;margin-top:2px}
.mail-foot{margin:0;padding:10px 20px;background:#f4efe6;border-top:1px solid #e2d8c7;font-size:12px;color:#7b7363}
@media (max-width:640px){.mf dl{grid-template-columns:1fr}.mail-meta{grid-template-columns:1fr}.mail-meta dt{padding-top:6px}}
`;
const hlMoney = s => esc(s).replace(/(-?\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g, '<span class="mail-amt">$1</span>');
const mailParas = s => String(s || '').split(/\n{2,}|\n/).filter(x => x.trim()).map(x => `<p>${hlMoney(x)}</p>`).join('');
const levelOf = (S, f) => (S.selection.find(s => s.id === f.id) || {}).level || f.level;

function mailParts(n, S) {
  const r = roleOf(S.role);
  const obs = Object.values(S.qActions || {}).filter(a => a.action === 'observation');
  const sections = [{ key: 'body', title: S.role === 'admin' ? 'Resumen' : 'Exposición' }];
  if ((n.findings || []).length) sections.push({ key: 'findings', title: 'Hallazgos por orden de urgencia' });
  if (obs.length) sections.push({ key: 'obs', title: r.obsPanel });
  if ((n.questionsForCommittee || []).length) sections.push({ key: 'questions', title: r.questions });
  return { r, obs, sections };
}

export function alertBody(n, S) {
  const { r, obs, sections } = mailParts(n, S);
  const sec = (k, html) => { const i = sections.findIndex(x => x.key === k); return i < 0 ? '' : `<section class="mail-sec"><h4><span class="n">${i + 1}</span>${esc(sections[i].title)}</h4>${html}</section>`; };
  return `<style>${MAIL_CSS}</style><h2>${esc(r.note)} <span class="src ia">IA</span></h2>
  <article class="mail" aria-label="${esc(r.note)}">
    <header class="mail-h"><div class="mail-kind">${esc(r.note)}</div>
      <dl class="mail-meta"><dt>Para</dt><dd>${esc(n.addressee)}</dd><dt>De</dt><dd>${esc(n.sender)}</dd><dt>Asunto</dt><dd class="subj">${esc(n.reference)}</dd><dt>Fecha</dt><dd>${esc(n.date)}</dd><dt>Adjunto</dt><dd>Reporte ejecutivo completo (HTML)</dd></dl>
    </header>
    <div class="mail-b">
      ${sec('body', mailParas(n.body))}
      ${sec('findings', (n.findings || []).map((f, i) => { const lv = levelOf(S, f); return `<div class="mf ${esc(lv)}"><div class="mf-t"><span class="k">${i + 1}.</span>${esc(f.title)}<span class="mpill ${esc(lv)}">${esc(LEVEL_LABEL[lv] || '')}</span></div><dl>${f.risk ? `<dt>Riesgo</dt><dd>${hlMoney(f.risk)}</dd>` : ''}${f.requiredAction ? `<dt>Acción requerida</dt><dd>${hlMoney(f.requiredAction)}</dd>` : ''}${f.suggestedDeadline ? `<dt>Plazo sugerido</dt><dd><span class="due">${esc(f.suggestedDeadline)}</span></dd>` : ''}</dl></div>`; }).join(''))}
      ${sec('obs', `<ol class="mail-list">${obs.map(o => `<li>${hlMoney(o.text)}</li>`).join('')}</ol>`)}
      ${sec('questions', `<div class="mail-q"><ol class="mail-list">${(n.questionsForCommittee || []).map(q => `<li>${hlMoney(q)}</li>`).join('')}</ol></div>`)}
      ${n.legalWarning ? `<div class="mail-warn"><strong>Advertencia</strong>${mailParas(n.legalWarning)}</div>` : ''}
      <div class="mail-sign">Atentamente,<b>${esc(n.sender)}</b></div>
    </div>
    <p class="mail-foot">Se adjunta el reporte ejecutivo completo como soporte. Documento redactado con asistencia de IA; no se envía automáticamente.</p>
  </article>`;
}

// Versión en texto para pegar en el cuerpo de un correo.
export function alertPlainText(n, S) {
  const { obs, sections } = mailParts(n, S);
  const head = k => { const i = sections.findIndex(x => x.key === k); return `${i + 1}. ${sections[i].title.toUpperCase()}`; };
  const out = [`Para: ${n.addressee}`, `De: ${n.sender}`, `Asunto: ${n.reference}`, `Fecha: ${n.date}`, 'Adjunto: Reporte ejecutivo completo (HTML)', '', head('body'), String(n.body || '').trim()];
  if ((n.findings || []).length) {
    out.push('', head('findings'));
    (n.findings || []).forEach((f, i) => {
      out.push(`${i + 1}) ${f.title} [${LEVEL_LABEL[levelOf(S, f)] || ''}]`);
      if (f.risk) out.push(`   Riesgo: ${f.risk}`);
      if (f.requiredAction) out.push(`   Acción requerida: ${f.requiredAction}`);
      if (f.suggestedDeadline) out.push(`   Plazo sugerido: ${f.suggestedDeadline}`);
    });
  }
  if (obs.length) { out.push('', head('obs')); obs.forEach((o, i) => out.push(`${i + 1}) ${o.text}`)); }
  if ((n.questionsForCommittee || []).length) { out.push('', head('questions')); n.questionsForCommittee.forEach((q, i) => out.push(`${i + 1}) ${q}`)); }
  if (n.legalWarning) out.push('', `ADVERTENCIA: ${String(n.legalWarning).trim()}`);
  out.push('', 'Atentamente,', n.sender, '', 'Se adjunta el reporte ejecutivo completo como soporte.');
  return out.join('\n');
}

export function standaloneReport(S, ind, { preview = false, logo = '' } = {}) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=IBM+Plex+Mono:wght@400;600&family=Instrument+Sans:wght@400;600&display=swap"><title>Reporte ${esc(S.condo.name)} ${esc(ind.periodFrom)}–${esc(ind.periodTo)}</title><style>${DOC_CSS}</style></head><body>${preview ? '' : `<div class="printbar"><span>Reporte ejecutivo condominial · ${esc(S.condo.name)}</span><button onclick="window.print()">Imprimir / Guardar PDF</button></div>`}<div class="page">${reportBody(S, ind, { includeNote: !preview || !!S.alert?.acceptedAt, logo })}<p class="muted" style="margin-top:28px">Generado con Condominio / Análisis de estados de cuenta — Workflow con IA. Caso ${esc(S.caseId)}. Cierre: ${S.closedAt ? esc(new Date(S.closedAt).toLocaleString('es-MX')) : 'pendiente'}.</p></div></body></html>`;
}
