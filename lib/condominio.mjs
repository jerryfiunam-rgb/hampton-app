// Motor condominial: categorías, validación aritmética, indicadores y reglas de anomalías.
// Código puro (sin DOM ni red): lo usan el navegador, el servidor y las pruebas.

export const TOL = 1; // tolerancia de cuadre en MXN

export const CATEGORIES = [
  { id: 'ING_ORD', label: 'Ingresos ordinarios', group: 'ingreso', kw: ['CUOTA', 'MANTENIMIENTO MENS', 'PAGO MENSUAL', 'QUINCENA', 'CONDOMINIAL', 'PENALIZACION', 'RECARGO', 'MANTTO DEPTO', 'PAGO DEPTO', 'DEPTO'] },
  { id: 'ING_EXT', label: 'Ingresos extraordinarios', group: 'ingreso', kw: ['EXTRAORDINARI', 'FONDO DE RESERVA', 'FONDO RESERVA', 'RENTA SALON', 'RENTA JARDIN', 'RENTA DE SALON', 'RENTA DE JARDIN', 'RENTA ESPACIO', 'APORTACION IMPERMEAB', 'APORTACION CANALETA'] },
  { id: 'CUOTAS_PEND', label: 'Cuotas pendientes de aplicar', group: 'ingreso', kw: ['ANTICIPO', 'POR APLICAR', 'PENDIENTE DE APLICAR', 'SIN REFERENCIA'] },
  { id: 'INTERESES', label: 'Intereses bancarios', group: 'ingreso', kw: ['INTERES', 'RENDIMIENTO', 'INVERSION'] },
  { id: 'TRANSFER', label: 'Transferencias entre fondos', group: 'neutral', kw: ['TRASPASO ENTRE', 'TRASPASO PROPIO', 'ENTRE CUENTAS PROPIAS', 'TRASPASO A FONDO', 'TRASPASO DE FONDO'] },
  { id: 'EF_SEGURIDAD', label: 'Egresos fijos — Seguridad', group: 'fijo', kw: ['VIGILANCIA', 'GUARDIA', 'SEGURIDAD', 'POLICIA'] },
  { id: 'EF_LIMPIEZA', label: 'Egresos fijos — Limpieza', group: 'fijo', kw: ['LIMPIEZA', 'INTENDENCIA', 'DESINFECCION'] },
  { id: 'EF_AREAS_VERDES', label: 'Egresos fijos — Áreas verdes', group: 'fijo', kw: ['JARDIN', 'PODA', 'FERTILIZ'] },
  { id: 'EF_RECOLECCION', label: 'Egresos fijos — Recolección', group: 'fijo', kw: ['BASURA', 'RECOLECCION', 'RESIDUOS'] },
  { id: 'EF_CONTABILIDAD', label: 'Egresos fijos — Contabilidad', group: 'fijo', kw: ['CONTADOR', 'CONTABILIDAD', 'CONTABLE'] },
  { id: 'EF_TELEFONIA', label: 'Egresos fijos — Telefonía/Internet', group: 'fijo', kw: ['TELEFON', 'INTERNET', 'TOTALPLAY', 'TELMEX', 'IZZI', 'INTERFON', 'INTERCOMUNIC'] },
  { id: 'EF_ENERGIA', label: 'Egresos fijos — Energía eléctrica', group: 'fijo', kw: ['CFE', 'COMISION FEDERAL', 'LUZ', 'ALUMBRADO', 'ENERGIA ELECTRICA'] },
  { id: 'EV_FUMIGACION', label: 'Egresos variables — Fumigación', group: 'variable', kw: ['FUMIGA', 'PLAGA', 'ROEDOR'] },
  { id: 'EV_MANTENIMIENTO', label: 'Egresos variables — Mantenimiento', group: 'variable', kw: ['REPARACION', 'PINTURA', 'MATERIAL', 'REFACCION', 'HERRAMIENTA', 'PLOMER', 'ELECTRICISTA', 'BOMBA', 'HERRERIA'] },
  { id: 'EV_SOFTWARE', label: 'Egresos variables — Software', group: 'variable', kw: ['VIVOOK', 'SOFTWARE', 'PLATAFORMA', 'SUSCRIPCION', 'LICENCIA'] },
  { id: 'EV_IMPUESTOS', label: 'Egresos variables — Impuestos', group: 'variable', kw: ['SAT', 'ISR', 'IMPUESTO', 'RETENCION', 'DECLARACION'] },
  { id: 'HONORARIOS', label: 'Honorarios de administración', group: 'admin', kw: ['HONORARIOS ADMIN', 'ADMINISTRACION', 'ADMINISTRADOR', 'ADMINISTRADORA'] },
  { id: 'CAJA_CHICA', label: 'Reembolso caja chica', group: 'admin', kw: ['CAJA CHICA', 'REEMBOLSO', 'REPOSICION'] },
  { id: 'IMPERMEABILIZACION', label: 'Impermeabilización', group: 'especial', kw: ['IMPERMEAB'] },
  { id: 'CANALETAS', label: 'Canaletas / instalaciones', group: 'especial', kw: ['CANALETA', 'INSTALACION'] },
  { id: 'COMISIONES', label: 'Comisiones bancarias', group: 'banco', kw: ['COMISION', 'IVA COM', 'CARGO POR SERVICIO', 'MEMBRESIA', 'ANUALIDAD'] },
  { id: 'NO_CLASIFICADO', label: 'No clasificado', group: 'otro', kw: [] },
];
export const CATEGORY_IDS = CATEGORIES.map(c => c.id);
export const catLabel = id => (CATEGORIES.find(c => c.id === id) || CATEGORIES.at(-1)).label;
export const catGroup = id => (CATEGORIES.find(c => c.id === id) || CATEGORIES.at(-1)).group;
export const FIXED_CATS = CATEGORIES.filter(c => c.group === 'fijo').map(c => c.id);
export const LEVELS = ['critical', 'moderate', 'observation'];
export const LEVEL_LABEL = { critical: 'Crítico', moderate: 'Moderado', observation: 'Observación' };
export const KINDS = ['arithmetic_error', 'continuity_error', 'missing_payment', 'unusual_expense', 'potential_duplicate', 'committed_funds', 'irregular_fixed', 'observation'];

const INCOME_ONLY = new Set(['ING_ORD', 'ING_EXT', 'CUOTAS_PEND', 'INTERESES']);

export function normText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

// Sugiere categoría por palabras clave del concepto bancario. El orden importa:
// las categorías especiales y de egreso específico se evalúan antes que las genéricas.
const ORDER_EXPENSE = ['IMPERMEABILIZACION', 'CANALETAS', 'TRANSFER', 'CAJA_CHICA', 'HONORARIOS', 'EF_SEGURIDAD', 'EF_LIMPIEZA', 'EF_AREAS_VERDES', 'EF_RECOLECCION', 'EF_CONTABILIDAD', 'EF_TELEFONIA', 'EF_ENERGIA', 'EV_FUMIGACION', 'EV_SOFTWARE', 'EV_IMPUESTOS', 'EV_MANTENIMIENTO', 'COMISIONES'];
const ORDER_INCOME = ['TRANSFER', 'INTERESES', 'CUOTAS_PEND', 'ING_EXT', 'ING_ORD'];
export function suggestCategory(concept, type) {
  const t = normText(concept);
  if (!t) return 'NO_CLASIFICADO';
  const order = type === 'abono' ? ORDER_INCOME : ORDER_EXPENSE;
  for (const id of order) {
    const c = CATEGORIES.find(x => x.id === id);
    if (c.kw.some(k => t.includes(k))) return id;
  }
  if (type === 'abono' && /IMPERMEAB|CANALETA|RESERVA/.test(t)) return 'ING_EXT';
  return 'NO_CLASIFICADO';
}

// ---------- Tipo de fondo y origen de cada movimiento ----------
export const FUND_ADMIN = 'Fondo de Administración y Mantenimiento';
export const FUND_NONE = 'No especificado';
export const FUND_OPTIONS = [FUND_ADMIN, 'Fondo de Reserva', 'Fondo de Impermeabilización', 'Fondo de Canaletas', 'Anticipos de condóminos', FUND_NONE];
// Fondos que se tratan como recursos comprometidos (no el operativo ni el no especificado).
export const isSpecialFund = f => !!f && f !== FUND_ADMIN && f !== FUND_NONE;

// Unifica el nombre de un fondo escrito de distintas formas.
export function normalizeFund(name) {
  const t = normText(name);
  if (!t || /^(NULL|NINGUNO|N\/A|NO ESPECIFICADO|DESCONOCIDO|SIN FONDO)$/.test(t)) return null;
  if (/ADMINISTRACION|OPERACION|ORDINARI|MANTENIMIENTO/.test(t)) return FUND_ADMIN;
  if (t.includes('IMPERMEAB')) return 'Fondo de Impermeabilización';
  if (t.includes('CANALETA')) return 'Fondo de Canaletas';
  if (t.includes('RESERVA')) return 'Fondo de Reserva';
  if (t.includes('ANTICIPO')) return 'Anticipos de condóminos';
  return String(name).trim().slice(0, 60);
}

export function detectFund(concept) {
  const t = normText(concept);
  if (t.includes('IMPERMEAB')) return 'Fondo de Impermeabilización';
  if (t.includes('CANALETA')) return 'Fondo de Canaletas';
  if (t.includes('RESERVA')) return 'Fondo de Reserva';
  if (t.includes('ANTICIPO')) return 'Anticipos de condóminos';
  return null;
}

// Política del condominio: las cuotas ordinarias entran y los gastos corrientes de operación salen del
// Fondo de Administración y Mantenimiento. Si no hay certeza, "No especificado".
export const OPEX_CATEGORIES = new Set(['EF_SEGURIDAD', 'EF_LIMPIEZA', 'EF_AREAS_VERDES', 'EF_RECOLECCION', 'EF_CONTABILIDAD', 'EF_TELEFONIA', 'EF_ENERGIA', 'EV_FUMIGACION', 'EV_MANTENIMIENTO', 'EV_SOFTWARE', 'EV_IMPUESTOS', 'HONORARIOS', 'CAJA_CHICA', 'COMISIONES']);
export function defaultFund(category, concept) {
  const byConcept = detectFund(concept);
  if (byConcept) return byConcept;
  if (category === 'ING_ORD' || OPEX_CATEGORIES.has(category)) return FUND_ADMIN;
  if (category === 'IMPERMEABILIZACION') return 'Fondo de Impermeabilización';
  if (category === 'CANALETAS') return 'Fondo de Canaletas';
  if (category === 'CUOTAS_PEND') return 'Anticipos de condóminos';
  return FUND_NONE;
}
export const resolveFund = (fund, category, concept) => normalizeFund(fund) || defaultFund(category, concept);

// Origen (torre o edificio y departamento) a partir del texto del movimiento.
const UNIT_RE = /\b(TORRE|EDIFICIO|EDIF|ED|TO|T|E)\.?\s*(\d{1,2}|[A-H])\b\s*(?:[-–\/,]\s*)?(?:DEPARTAMENTO|DEPTO|DPTO|DEP|D|NO|#)?\.?\s*(\d{2,4}[A-Z]?)\b(?!\s*[-–]\s*\d)/;
const DEPTO_RE = /\b(?:DEPARTAMENTO|DEPTO|DPTO)\.?\s*#?\s*(\d{2,4}[A-Z]?)\b(?!\s*[-–]\s*\d)/;
export function extractOrigin(text) {
  const t = normText(text);
  const m = t.match(UNIT_RE);
  const isYear = x => /^(19|20)\d{2}$/.test(x);
  if (m && !isYear(m[3]) && !(m[1].length <= 2 && !/^\d/.test(m[2]))) return `${/^E/.test(m[1]) ? 'Edificio' : 'Torre'} ${m[2]} - ${m[3]}`;
  const d = t.match(DEPTO_RE);
  return d && !isYear(d[1]) ? `Depto ${d[1]}` : '';
}
export const formatOrigin = s => { const t = String(s || '').trim(); return t ? (extractOrigin(t) || t.slice(0, 40)) : ''; };
const REFUND_RE = /REEMBOLSO|DEVOLUCION|REINTEGRO/;

export const isCash = concept => /EFECTIVO|DEP\.? EFVO|DEPOSITO EN VENTANILLA/.test(normText(concept));
const JUSTIFIED_CASH = /RENTA|SALON|JARDIN|RECIBO|FACTURA|CUOTA/;

export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Convierte "1,234.56", "$ 1 234.56", "(1,234.56)" a número.
export function parseAmount(s) {
  if (typeof s === 'number') return s;
  const raw = String(s || '').trim();
  if (!raw) return null;
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw);
  const clean = raw.replace(/[^0-9.,]/g, '');
  if (!clean) return null;
  let v;
  if (/,\d{2}$/.test(clean) && !/\.\d{2}$/.test(clean)) v = Number(clean.replace(/\./g, '').replace(',', '.'));
  else v = Number(clean.replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

export const fmtMXN = n => (n === null || n === undefined || !Number.isFinite(Number(n)))
  ? 'No identificado'
  : Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });

// ---------- Mapeo mensual ----------

export function movementTotals(movs) {
  let income = 0, expense = 0, unknown = 0;
  for (const m of movs) {
    if (m.amount === null || m.amount === undefined) { unknown++; continue; }
    if (m.type === 'abono') income += Number(m.amount); else expense += Number(m.amount);
  }
  return { income: round2(income), expense: round2(expense), unknown };
}

// Recalcula totales y cuadre de un mes a partir de sus movimientos (fuente de verdad del motor).
export function recomputeMonth(month) {
  const all = [...(month.movements || []), ...(month.unclassifiedMovements || [])];
  // re-separa movimientos no clasificados por categoría
  const movements = all.filter(m => m.category !== 'NO_CLASIFICADO');
  const unclassifiedMovements = all.filter(m => m.category === 'NO_CLASIFICADO');
  const t = movementTotals(all);
  const ini = num(month.initialBalance), fin = num(month.finalBalance);
  const expectedFinal = ini === null ? null : round2(ini + t.income - t.expense);
  const diff = expectedFinal === null || fin === null ? null : round2(fin - expectedFinal);
  const balanceCheck = diff !== null && Math.abs(diff) <= TOL && t.unknown === 0;
  // comparación con totales reportados en el resumen del estado de cuenta
  const rI = num(month.reportedIncome), rE = num(month.reportedExpense);
  const reportedDiff = (ini !== null && fin !== null && rI !== null && rE !== null) ? round2(fin - (ini + rI - rE)) : null;
  return {
    ...month,
    movements, unclassifiedMovements,
    totalIncome: t.income, totalExpense: t.expense, unknownAmounts: t.unknown,
    expectedFinal, balanceDiff: diff, balanceCheck,
    reportedDiff,
    incomeVsReported: rI === null ? null : round2(t.income - rI),
    expenseVsReported: rE === null ? null : round2(t.expense - rE),
  };
}

export function sortMonths(months) {
  return [...months].sort((a, b) => String(a.period).localeCompare(String(b.period)));
}

export function continuityChecks(months) {
  const ms = sortMonths(months);
  const out = [];
  for (let i = 1; i < ms.length; i++) {
    const prev = ms[i - 1], cur = ms[i];
    const a = num(prev.finalBalance), b = num(cur.initialBalance);
    const consecutive = nextPeriod(prev.period) === cur.period;
    const diff = a === null || b === null ? null : round2(b - a);
    out.push({ from: prev.period, to: cur.period, consecutive, prevFinal: a, nextInitial: b, diff, ok: diff !== null && Math.abs(diff) <= TOL });
  }
  return out;
}

export function nextPeriod(p) {
  const [y, m] = String(p).split('-').map(Number);
  if (!y || !m) return null;
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// Preguntas que genera el motor: montos no identificados y no clasificados.
// ---------- Liga de una pregunta con el movimiento al que se refiere ----------
// Usa el índice que dio Claude si el movimiento coincide con lo que dice la pregunta; si no, busca
// por monto (el primero mencionado pesa más), fecha y departamento.
function questionClues(prompt) {
  const t = String(prompt || '');
  const amounts = [...t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map(m => Number(m[1].replace(/,/g, ''))).filter(Number.isFinite);
  const dates = [
    ...[...t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`),
    ...[...t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)].map(m => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`),
  ];
  return { amounts, dates, origin: extractOrigin(t) };
}
export function linkQuestionMovement(prompt, movementIndex, movs) {
  const list = (movs || []).filter(m => m && m.amount !== null);
  if (!list.length) return null;
  const c = questionClues(prompt);
  const fits = mv => !c.amounts.length || c.amounts.some(a => Math.abs(a - Number(mv.amount)) < 0.01);
  if (Number.isInteger(movementIndex)) for (const i of [movementIndex, movementIndex - 1]) if (movs[i] && movs[i].amount !== null && fits(movs[i])) return movs[i].id;
  if (!c.amounts.length) return null;
  let best = null, bestScore = 0;
  for (const mv of list) {
    let sc = 0;
    if (Math.abs(c.amounts[0] - Number(mv.amount)) < 0.01) sc += 4; else if (fits(mv)) sc += 1;
    if (sc === 0) continue;
    if (c.dates.includes(mv.date)) sc += 2;
    if (c.origin && mv.origin && unitKey(c.origin) === unitKey(mv.origin)) sc += 3;
    else if (c.origin && normText(mv.concept).includes(normText(c.origin).replace(/ - /g, ' '))) sc += 2;
    if (sc > bestScore) { best = mv; bestScore = sc; }
  }
  return bestScore >= 4 ? best.id : null;
}

// ---------- Movimientos con fecha fuera del período del estado de cuenta ----------
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export function periodWindow(month) {
  const [y, m] = String(month.period).split('-').map(Number);
  if (!y || !m) return null;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const prevFirst = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  // Con fechas de corte del estado de cuenta: ±3 días. Sin ellas: del mes anterior al fin del mes del período.
  if (month.periodStart && month.periodEnd) return { from: addDays(month.periodStart, -3), to: addDays(month.periodEnd, 3), label: `${month.periodStart} a ${month.periodEnd}` };
  return { from: prevFirst, to: last, label: `${prevFirst.slice(0, 7)} a ${month.period}` };
}
export function outOfPeriod(month) {
  const w = periodWindow(month);
  if (!w) return [];
  return [...(month.movements || []), ...(month.unclassifiedMovements || [])].filter(mv => !mv.dateUncertain && (mv.date < w.from || mv.date > w.to));
}
// Cuadre del mes si se excluyen los movimientos indicados (para decidir con evidencia).
export function balanceWithout(month, ids) {
  const keep = m => !ids.has(m.id);
  return recomputeMonth({ ...month, movements: (month.movements || []).filter(keep), unclassifiedMovements: (month.unclassifiedMovements || []).filter(keep) });
}

// Abonos (o reembolsos) iguales —misma fecha, concepto, monto y página— sin departamento identificado.
export function unidentifiedGroups(month) {
  const groups = new Map();
  for (const mv of [...(month.movements || []), ...(month.unclassifiedMovements || [])]) {
    if (mv.origin || mv.amount === null) continue;
    if (!(mv.type === 'abono' || REFUND_RE.test(normText(mv.concept)))) continue;
    const k = [mv.date, normText(mv.concept), round2(mv.amount), mv.type, mv.sourcePageNumber].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(mv);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

export function engineQuestions(months) {
  const qs = [];
  for (const m of months) {
    const oop = m.outOfPeriodDecision === 'keep' ? [] : outOfPeriod(m);
    if (oop.length) {
      const w = periodWindow(m);
      const without = balanceWithout(m, new Set(oop.map(x => x.id)));
      const fmtDiff = mm => mm.balanceDiff === null ? 'no verificable' : Math.abs(mm.balanceDiff) <= TOL ? 'cuadra' : `diferencia ${fmtMXN(mm.balanceDiff)}`;
      const dates = [...new Set(oop.map(x => x.date))].sort();
      qs.push({ id: `q-oop-${m.period}`, period: m.period, movementId: oop[0].id, kind: 'outofperiod', blocking: true, count: oop.length,
        prompt: `${oop.length} movimiento(s) tienen fecha fuera del período del estado de cuenta (${w.label}): ${dates.slice(0, 4).join(', ')}${dates.length > 4 ? '…' : ''}, por ${fmtMXN(oop.reduce((s, x) => s + Number(x.amount || 0), 0))}. Suelen venir del reporte de morosidad o de tablas de pagos anteriores, no de la cuenta. Cuadre del mes conservándolos: ${fmtDiff(m)}; excluyéndolos: ${fmtDiff(without)}.` });
    }
    for (const g of unidentifiedGroups(m)) {
      const x = g[0];
      qs.push({ id: `q-org-${x.id}`, period: m.period, movementId: x.id, kind: 'origin', blocking: false,
        prompt: `${g.length} abonos iguales «${x.concept}» por ${fmtMXN(x.amount)} del ${x.date}${x.sourcePageNumber ? ` (pág. ${x.sourcePageNumber})` : ''} no indican de qué departamento provienen. Verifica en el estado de cuenta si son pagos de departamentos distintos y captura el origen de cada uno en la tabla.` });
    }
    if (num(m.initialBalance) === null) qs.push({ id: `q-ini-${m.period}`, period: m.period, prompt: `No se identificó el saldo inicial de ${m.period}. Indica el monto según el estado de cuenta.`, blocking: true, kind: 'balance', field: 'initialBalance' });
    if (num(m.finalBalance) === null) qs.push({ id: `q-fin-${m.period}`, period: m.period, prompt: `No se identificó el saldo final de ${m.period}. Indica el monto según el estado de cuenta.`, blocking: true, kind: 'balance', field: 'finalBalance' });
    for (const mv of [...(m.movements || []), ...(m.unclassifiedMovements || [])]) {
      if (mv.amount === null || mv.amount === undefined) {
        qs.push({ id: `q-amt-${mv.id}`, period: m.period, movementId: mv.id, prompt: `Monto no identificado para «${mv.concept}» (${mv.date}). Indica el monto.`, blocking: true, kind: 'amount' });
      } else if (mv.category === 'NO_CLASIFICADO' && Number(mv.amount) > 3000) {
        qs.push({ id: `q-cat-${mv.id}`, period: m.period, movementId: mv.id, prompt: `¿Qué categoría corresponde a «${mv.concept}» (${mv.date}, ${fmtMXN(mv.amount)}, ${mv.type})?`, blocking: mv.type === 'cargo' && Number(mv.amount) > 5000, kind: 'category' });
      }
    }
  }
  // Redacción sugerida para enviar la aclaración como observación a la administración.
  const movOf = q => q.movementId ? months.flatMap(m => [...(m.movements || []), ...(m.unclassifiedMovements || [])]).find(x => x.id === q.movementId) : null;
  for (const q of qs) {
    const mv = movOf(q);
    q.observationDraft = q.kind === 'balance' ? `Se solicita a la administración confirmar el ${q.field === 'initialBalance' ? 'saldo inicial' : 'saldo final'} de ${q.period}, que no aparece de forma legible en el estado de cuenta.`
      : q.kind === 'amount' && mv ? `Se solicita a la administración confirmar el monto del movimiento «${mv.concept}» del ${mv.date}, que no es legible en el estado de cuenta.`
      : q.kind === 'category' && mv ? `Se solicita a la administración aclarar el concepto y destino del ${mv.type} «${mv.concept}» del ${mv.date} por ${fmtMXN(mv.amount)}, y presentar el comprobante correspondiente.`
      : q.kind === 'origin' && mv ? `Se solicita a la administración indicar de qué departamento proviene cada uno de los abonos «${mv.concept}» por ${fmtMXN(mv.amount)} del ${mv.date}.`
      : `Se solicita a la administración aclarar lo siguiente: ${q.prompt}`;
  }
  return qs;
}

// ---------- Fondos especiales ----------
export function computeFunds(months, openingBalances = {}) {
  const map = new Map();
  const touch = (name) => { if (!map.has(name)) map.set(name, { name, buildingOrScope: '', amountCollected: 0, amountPaid: 0, opening: num(openingBalances[name]) || 0, lastUpdated: null }); return map.get(name); };
  for (const m of sortMonths(months)) {
    for (const mv of [...(m.movements || []), ...(m.unclassifiedMovements || [])]) {
      const fund = resolveFund(mv.fund, mv.category, mv.concept);
      if (!isSpecialFund(fund) || mv.amount === null) continue;
      const f = touch(fund);
      if (mv.scope && !f.buildingOrScope.includes(mv.scope)) f.buildingOrScope = [f.buildingOrScope, mv.scope].filter(Boolean).join(', ');
      if (mv.type === 'abono') f.amountCollected += Number(mv.amount); else f.amountPaid += Number(mv.amount);
      f.lastUpdated = mv.date || m.period;
    }
  }
  for (const k of Object.keys(openingBalances)) if (isSpecialFund(normalizeFund(k)) && num(openingBalances[k]) !== null) touch(k);
  return [...map.values()].map(f => ({ ...f, amountCollected: round2(f.amountCollected), amountPaid: round2(f.amountPaid), balance: round2(f.opening + f.amountCollected - f.amountPaid) }));
}

// Fondo operativo (cuotas ordinarias). Se muestra junto a los fondos especiales, pero no es fondo comprometido.
export function computeAdminFund(months, openingBalances = {}) {
  const f = { name: FUND_ADMIN, operational: true, buildingOrScope: '', amountCollected: 0, amountPaid: 0, opening: num(openingBalances[FUND_ADMIN]) || 0, lastUpdated: null, movements: 0 };
  for (const m of sortMonths(months)) for (const mv of [...(m.movements || []), ...(m.unclassifiedMovements || [])]) {
    if (mv.amount === null || resolveFund(mv.fund, mv.category, mv.concept) !== FUND_ADMIN) continue;
    if (mv.type === 'abono') f.amountCollected += Number(mv.amount); else f.amountPaid += Number(mv.amount);
    f.lastUpdated = mv.date || m.period; f.movements++;
  }
  if (!f.movements && !f.opening) return null;
  return { ...f, amountCollected: round2(f.amountCollected), amountPaid: round2(f.amountPaid), balance: round2(f.opening + f.amountCollected - f.amountPaid) };
}

// ---------- Indicadores (módulo 8.2) ----------
export function categoryTotalsByMonth(months) {
  const res = {};
  for (const m of sortMonths(months)) {
    const t = {};
    for (const mv of [...(m.movements || []), ...(m.unclassifiedMovements || [])]) {
      if (mv.amount === null) continue;
      const key = mv.category;
      t[key] = t[key] || { cargo: 0, abono: 0 };
      t[key][mv.type] += Number(mv.amount);
    }
    for (const k in t) { t[k].cargo = round2(t[k].cargo); t[k].abono = round2(t[k].abono); }
    res[m.period] = t;
  }
  return res;
}

const pct = (a, b) => (b ? round2((a / b) * 100) : null);

export function computeIndicators(months, condo = {}, fundOpenings = {}) {
  const ms = sortMonths(months.map(recomputeMonth));
  const cats = categoryTotalsByMonth(ms);
  const units = num(condo.units), fee = num(condo.monthlyFee);
  const delinquency = computeDelinquency(ms, units);
  const debt = num(condo.delinquentDebt) ?? delinquency.latestTotal;
  const flow = ms.map((m, i) => {
    const c = cats[m.period] || {};
    const fixed = FIXED_CATS.reduce((s, k) => s + (c[k]?.cargo || 0), 0);
    const ordinaryIncome = c.ING_ORD?.abono || 0;
    const theoretical = units && fee ? units * fee : null;
    const prev = ms[i - 1];
    const net = round2(m.totalIncome - m.totalExpense);
    const varSaldo = num(m.initialBalance) !== null && num(m.finalBalance) !== null ? round2(m.finalBalance - m.initialBalance) : null;
    return {
      period: m.period,
      initialBalance: num(m.initialBalance), finalBalance: num(m.finalBalance),
      totalIncome: m.totalIncome, totalExpense: m.totalExpense,
      netFlow: net, balanceVariation: varSaldo,
      flowVsVariationDiff: varSaldo === null ? null : round2(varSaldo - net),
      balanceCheck: m.balanceCheck, balanceDiff: m.balanceDiff,
      incomeChangePct: prev && prev.totalIncome ? pct(m.totalIncome - prev.totalIncome, prev.totalIncome) : null,
      expenseChangePct: prev && prev.totalExpense ? pct(m.totalExpense - prev.totalExpense, prev.totalExpense) : null,
      ordinaryIncome: round2(ordinaryIncome),
      theoreticalIncome: theoretical,
      collectionRatePct: theoretical ? pct(ordinaryIncome, theoretical) : null,
      fixedExpense: round2(fixed),
      fixedConcentrationPct: m.totalExpense ? pct(fixed, m.totalExpense) : null,
      ordinaryExpense: round2(m.totalExpense - ['IMPERMEABILIZACION', 'CANALETAS', 'TRANSFER'].reduce((s, k) => s + (c[k]?.cargo || 0), 0)),
    };
  });

  // composición de egresos del período y variación mensual por categoría
  const composition = {};
  for (const p in cats) for (const k in cats[p]) if (cats[p][k].cargo) composition[k] = round2((composition[k] || 0) + cats[p][k].cargo);
  const totalExp = Object.values(composition).reduce((a, b) => a + b, 0);
  const compositionList = Object.entries(composition).map(([id, amount]) => ({ id, label: catLabel(id), amount, pct: pct(amount, totalExp) })).sort((a, b) => b.amount - a.amount);

  const categoryChanges = [];
  for (let i = 1; i < ms.length; i++) {
    const a = cats[ms[i - 1].period] || {}, b = cats[ms[i].period] || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const pa = a[k]?.cargo || 0, pb = b[k]?.cargo || 0;
      if (!pa) continue;
      const ch = pct(pb - pa, pa);
      categoryChanges.push({ category: k, label: catLabel(k), from: ms[i - 1].period, to: ms[i].period, prev: pa, cur: pb, changePct: ch, flagged: Math.abs(ch) > 20 });
    }
  }

  const funds = computeFunds(ms, fundOpenings);
  const adminFund = computeAdminFund(ms, fundOpenings);
  const committed = round2(funds.reduce((s, f) => s + Math.max(0, f.balance), 0));
  const last = ms.at(-1);
  const bankBalance = last ? num(last.finalBalance) : null;
  const free = bankBalance === null ? null : round2(bankBalance - committed);
  const avgOrdExp = flow.length ? round2(flow.reduce((s, f) => s + f.ordinaryExpense, 0) / flow.length) : null;
  const totalOrdIncome = flow.reduce((s, f) => s + f.ordinaryIncome, 0);
  const annualizedOrd = flow.length ? round2((totalOrdIncome / flow.length) * 12) : null;

  return {
    months: flow,
    composition: compositionList,
    categoryChanges,
    funds,
    adminFund,
    committedFunds: committed,
    bankBalance,
    committedPct: bankBalance ? pct(committed, bankBalance) : null,
    freeBalance: free,
    avgOrdinaryExpense: avgOrdExp,
    monthsCovered: free !== null && avgOrdExp ? round2(free / avgOrdExp) : null,
    delinquencyIndexPct: debt !== null && annualizedOrd ? pct(debt, annualizedOrd) : null,
    delinquentDebt: debt,
    delinquencySource: num(condo.delinquentDebt) !== null ? 'usuario' : delinquency.latestTotal !== null ? 'pdf' : null,
    delinquency,
    annualizedOrdinaryIncome: annualizedOrd,
    periodFrom: ms[0]?.period || null, periodTo: last?.period || null,
    continuity: continuityChecks(ms),
    gaps: ms.slice(1).filter((m, i) => nextPeriod(ms[i].period) !== m.period).map(m => m.period),
  };
}

// ---------- Reglas de anomalías (módulo 8.3) ----------
function allMovs(m) { return [...(m.movements || []), ...(m.unclassifiedMovements || [])]; }

// ---------- Morosidad por departamento (reporte al final del estado de cuenta) ----------
export const unitKey = u => normText(u).replace(/[^A-Z0-9]/g, '');

export function normalizeDelinquency(raw, period) {
  if (!raw || typeof raw !== 'object') return null;
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).map((r, i) => ({
    id: `${period}-D${String(i + 1).padStart(3, '0')}`,
    unit: String(r.unit || r.departamento || '').trim().slice(0, 60),
    amount: (() => { const v = num(typeof r.amount === 'string' ? parseAmount(r.amount) : r.amount); return v === null ? null : Math.abs(v); })(),
    months: num(r.months),
    detail: String(r.detail || '').slice(0, 200),
    sourcePageNumber: Number.isInteger(r.sourcePageNumber) ? r.sourcePageNumber : null,
  })).filter(r => r.unit);
  const reportedTotal = num(typeof raw.reportedTotal === 'string' ? parseAmount(raw.reportedTotal) : raw.reportedTotal);
  if (!rows.length && reportedTotal === null && !raw.found) return { found: false, asOf: null, reportedTotal: null, rows: [] };
  return { found: true, asOf: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.asOf)) ? raw.asOf : null, reportedTotal, rows };
}

export function delinquencyRows(months) {
  return sortMonths(months).flatMap(m => (m.delinquency?.rows || []).map(r => ({ ...r, period: m.period, asOf: m.delinquency.asOf })));
}

export function computeDelinquency(months, units = null) {
  const ms = sortMonths(months).filter(m => m.delinquency?.found);
  const perMonth = ms.map(m => {
    const rows = m.delinquency.rows;
    const total = round2(rows.reduce((s, r) => s + Number(r.amount || 0), 0));
    const rt = num(m.delinquency.reportedTotal);
    const owing = rows.filter(r => Number(r.amount) > 0).length;
    return { period: m.period, asOf: m.delinquency.asOf, total, reportedTotal: rt, totalDiff: rt === null ? null : round2(rt - total), unitsOwing: owing, unitsPct: units ? pct(owing, units) : null, unknownAmounts: rows.filter(r => r.amount === null).length };
  });
  // tabla por departamento a lo largo del período
  const byUnit = new Map();
  for (const m of ms) for (const r of m.delinquency.rows) {
    const k = unitKey(r.unit);
    if (!byUnit.has(k)) byUnit.set(k, { key: k, unit: r.unit, amounts: {}, months: {}, ids: {} });
    const u = byUnit.get(k);
    u.amounts[m.period] = r.amount; u.months[m.period] = r.months; u.ids[m.period] = r.id;
  }
  const periods = ms.map(m => m.period);
  const last = periods.at(-1), prev = periods.at(-2);
  const unitsTable = [...byUnit.values()].map(u => {
    const cur = last in u.amounts ? u.amounts[last] : 0;
    const before = prev ? (prev in u.amounts ? u.amounts[prev] : 0) : null;
    let status = 'sin comparación';
    if (before !== null && cur !== null) status = !before && cur ? 'nuevo' : before && !cur ? 'liquidado' : cur > before + TOL ? 'aumentó' : cur < before - TOL ? 'disminuyó' : 'sin cambio';
    return { ...u, current: cur, previous: before, change: before === null || cur === null ? null : round2(cur - before), monthsOwed: u.months[last] ?? null, status, latestId: u.ids[last] || Object.values(u.ids).at(-1) };
  }).sort((a, b) => (b.current || 0) - (a.current || 0));
  const lastM = perMonth.at(-1), prevM = perMonth.at(-2);
  return {
    periods, perMonth, units: unitsTable,
    latestPeriod: last || null,
    latestTotal: lastM ? lastM.total : null,
    previousTotal: prevM ? prevM.total : null,
    changePct: lastM && prevM && prevM.total ? pct(lastM.total - prevM.total, prevM.total) : null,
    unitsOwing: lastM ? lastM.unitsOwing : null,
    unitsPct: lastM ? lastM.unitsPct : null,
    oldDebtUnits: unitsTable.filter(u => Number(u.monthsOwed) >= 3 && u.current > 0),
    missingPeriods: sortMonths(months).filter(m => !m.delinquency?.found).map(m => m.period),
  };
}

export function detectAnomalies(months, indicators, opts = {}) {
  const ms = sortMonths(months.map(recomputeMonth));
  const ind = indicators || computeIndicators(ms);
  const out = [];
  let n = 0;
  const add = (rule, level, kind, title, detail, evidence, extra = {}) => out.push({ id: `R${String(++n).padStart(2, '0')}`, rule, level, kind, title, detail, evidence: evidence.filter(Boolean), ...extra });
  const firstMov = m => allMovs(m)[0]?.id;

  for (const m of ms) {
    if (m.balanceDiff !== null && Math.abs(m.balanceDiff) > TOL) {
      add('cuadre', 'critical', 'arithmetic_error', `Descuadre aritmético en ${m.period}`,
        `Saldo inicial ${fmtMXN(m.initialBalance)} + ingresos ${fmtMXN(m.totalIncome)} − egresos ${fmtMXN(m.totalExpense)} = ${fmtMXN(m.expectedFinal)}, pero el estado reporta ${fmtMXN(m.finalBalance)}. Diferencia: ${fmtMXN(m.balanceDiff)}.`,
        [firstMov(m)], { period: m.period, amount: m.balanceDiff });
    }
    if (m.reportedDiff !== null && Math.abs(m.reportedDiff) > TOL) {
      add('cuadre', 'critical', 'arithmetic_error', `Resumen del estado no cuadra en ${m.period}`,
        `Con los totales del resumen bancario, el saldo final esperado difiere en ${fmtMXN(m.reportedDiff)}.`, [firstMov(m)], { period: m.period, amount: m.reportedDiff });
    }
  }
  for (const c of ind.continuity) {
    if (c.consecutive && c.diff !== null && Math.abs(c.diff) > TOL) {
      const mm = ms.find(x => x.period === c.to);
      add('continuidad', 'critical', 'continuity_error', `Discontinuidad de saldo ${c.from} → ${c.to}`,
        `Saldo final de ${c.from}: ${fmtMXN(c.prevFinal)}; saldo inicial de ${c.to}: ${fmtMXN(c.nextInitial)}. Diferencia: ${fmtMXN(Math.abs(c.diff))}.`,
        [firstMov(mm)], { period: c.to, amount: Math.abs(c.diff) });
    }
  }
  for (const m of ms) for (const mv of allMovs(m)) {
    if (mv.type === 'cargo' && mv.category === 'NO_CLASIFICADO' && Number(mv.amount) > 5000) {
      add('sin_categoria', 'critical', 'unusual_expense', `Egreso grande sin categoría (${m.period})`,
        `«${mv.concept}» el ${mv.date} por ${fmtMXN(mv.amount)} no tiene categoría.`, [mv.id], { period: m.period, amount: mv.amount });
    }
  }
  // honorarios no pagados
  for (let i = 1; i < ms.length; i++) {
    const has = m => allMovs(m).some(x => x.category === 'HONORARIOS' && x.type === 'cargo');
    if (has(ms[i - 1]) && !has(ms[i])) {
      const ev = allMovs(ms[i - 1]).find(x => x.category === 'HONORARIOS');
      add('honorarios', 'moderate', 'missing_payment', `Sin pago de honorarios de administración en ${ms[i].period}`,
        `En ${ms[i - 1].period} hubo pago de honorarios (${fmtMXN(ev.amount)}), pero en ${ms[i].period} no hay ningún movimiento en esa categoría.`, [ev.id], { period: ms[i].period });
    }
  }
  // gasto variable alto (mantenimiento)
  if (ms.length >= 2) {
    const tot = ms.map(m => round2(allMovs(m).filter(x => x.category === 'EV_MANTENIMIENTO' && x.type === 'cargo').reduce((s, x) => s + Number(x.amount || 0), 0)));
    ms.forEach((m, i) => {
      const others = tot.filter((_, j) => j !== i);
      const avg = others.reduce((a, b) => a + b, 0) / others.length;
      if (tot[i] > 0 && avg > 0 && tot[i] > 1.5 * avg) {
        const ev = allMovs(m).filter(x => x.category === 'EV_MANTENIMIENTO').sort((a, b) => b.amount - a.amount).slice(0, 3).map(x => x.id);
        add('mantenimiento_alto', 'moderate', 'unusual_expense', `Mantenimiento elevado en ${m.period}`,
          `Mantenimiento ${fmtMXN(tot[i])} vs. promedio de los otros meses ${fmtMXN(avg)} (${round2(tot[i] / avg)}×).`, ev, { period: m.period, amount: tot[i] });
      }
    });
  }
  // duplicados probables
  for (const m of ms) {
    const cargos = allMovs(m).filter(x => x.type === 'cargo' && x.amount !== null);
    const seen = new Set();
    for (let i = 0; i < cargos.length; i++) for (let j = i + 1; j < cargos.length; j++) {
      const a = cargos[i], b = cargos[j];
      if (normText(a.concept) !== normText(b.concept)) continue;
      if (a.origin && b.origin && unitKey(a.origin) !== unitKey(b.origin)) continue;
      const sameDay = a.date === b.date && round2(a.amount) === round2(b.amount);
      const close = Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount) < 0.05;
      if ((sameDay || close) && !seen.has(a.id + b.id)) {
        seen.add(a.id + b.id);
        add('duplicado', 'moderate', 'potential_duplicate', `Pago duplicado probable: «${a.concept}»`,
          `Dos cargos «${a.concept}»: ${a.date} por ${fmtMXN(a.amount)} y ${b.date} por ${fmtMXN(b.amount)}.`, [a.id, b.id], { period: m.period, amount: b.amount });
      }
    }
  }
  // fondo comprometido alto
  if (ind.committedPct !== null && ind.committedPct > 70) {
    const m = ms.at(-1);
    add('fondo_comprometido', 'moderate', 'committed_funds', 'Fondo comprometido alto',
      `Los fondos especiales pendientes de aplicar (${fmtMXN(ind.committedFunds)}) equivalen al ${ind.committedPct}% del saldo bancario (${fmtMXN(ind.bankBalance)}).`, [firstMov(m)], { period: m.period, amount: ind.committedFunds });
  }
  // gasto fijo irregular
  for (let i = 1; i < ms.length; i++) for (const cat of FIXED_CATS) {
    const sum = m => allMovs(m).filter(x => x.category === cat && x.type === 'cargo').reduce((s, x) => s + Number(x.amount || 0), 0);
    const a = sum(ms[i - 1]), b = sum(ms[i]);
    if (a > 0 && b > 0 && Math.abs(b - a) / a > 0.05) {
      const ev = allMovs(ms[i]).find(x => x.category === cat);
      add('fijo_irregular', 'observation', 'irregular_fixed', `${catLabel(cat)} varía ${round2(((b - a) / a) * 100)}% en ${ms[i].period}`,
        `${catLabel(cat)}: ${fmtMXN(a)} en ${ms[i - 1].period} y ${fmtMXN(b)} en ${ms[i].period}.`, [ev.id], { period: ms[i].period, amount: round2(b - a) });
    }
  }
  // sin pago eléctrico dos meses consecutivos
  for (let i = 1; i < ms.length; i++) {
    const has = m => allMovs(m).some(x => x.category === 'EF_ENERGIA' && x.type === 'cargo');
    if (!has(ms[i - 1]) && !has(ms[i]) && nextPeriod(ms[i - 1].period) === ms[i].period) {
      add('sin_electrico', 'observation', 'missing_payment', `Sin pago de energía eléctrica en ${ms[i - 1].period} y ${ms[i].period}`,
        'Dos meses consecutivos sin egresos en la categoría Energía eléctrica.', [firstMov(ms[i])], { period: ms[i].period });
    }
  }
  // caja chica negativa
  for (const m of ms) if (num(m.pettyCashBalance) !== null && m.pettyCashBalance < 0) {
    add('caja_chica', 'observation', 'observation', `Caja chica negativa en ${m.period}`, `El resumen muestra caja chica de ${fmtMXN(m.pettyCashBalance)}.`, [firstMov(m)], { period: m.period });
  }
  // efectivo sin respaldo
  for (const m of ms) {
    const cash = allMovs(m).filter(x => x.type === 'abono' && (x.cash || isCash(x.concept)) && !JUSTIFIED_CASH.test(normText(x.concept)));
    const tot = cash.reduce((s, x) => s + Number(x.amount || 0), 0);
    if (tot > 10000) add('efectivo', 'observation', 'observation', `Ingresos en efectivo sin justificante en ${m.period}`,
      `${cash.length} depósitos en efectivo suman ${fmtMXN(tot)} sin referencia a renta u otro justificante.`, cash.map(x => x.id), { period: m.period, amount: round2(tot) });
  }
  // morosidad por departamento
  const D = ind.delinquency;
  if (D && D.perMonth.length) {
    for (const pm of D.perMonth) if (pm.totalDiff !== null && Math.abs(pm.totalDiff) > TOL) {
      const m = ms.find(x => x.period === pm.period);
      add('morosidad_total', 'observation', 'observation', `Reporte de morosidad de ${pm.period} no suma su total`,
        `La suma por departamento es ${fmtMXN(pm.total)} y el total del reporte es ${fmtMXN(pm.reportedTotal)} (diferencia ${fmtMXN(pm.totalDiff)}).`, (m.delinquency.rows[0] ? [m.delinquency.rows[0].id] : []), { period: pm.period, amount: pm.totalDiff });
    }
    if (D.changePct !== null && D.changePct > 10) {
      const up = D.units.filter(u => u.status === 'nuevo' || u.status === 'aumentó').slice(0, 5);
      add('morosidad_creciente', 'moderate', 'observation', `La morosidad aumentó ${D.changePct}% en ${D.latestPeriod}`,
        `Adeudo total ${fmtMXN(D.previousTotal)} → ${fmtMXN(D.latestTotal)}. Departamentos con adeudo nuevo o mayor: ${up.map(u => `${u.unit} (${fmtMXN(u.current)})`).join(', ') || 'ninguno identificado'}.`, up.map(u => u.latestId), { period: D.latestPeriod, amount: round2(D.latestTotal - D.previousTotal) });
    }
    if (D.oldDebtUnits.length) {
      const tot = round2(D.oldDebtUnits.reduce((s2, u) => s2 + u.current, 0));
      add('morosidad_antigua', 'moderate', 'missing_payment', `${D.oldDebtUnits.length} departamento(s) con 3 o más meses de adeudo`,
        `${D.oldDebtUnits.slice(0, 8).map(u => `${u.unit}: ${fmtMXN(u.current)} (${u.monthsOwed} meses)`).join('; ')}. Total: ${fmtMXN(tot)}.`, D.oldDebtUnits.slice(0, 8).map(u => u.latestId), { period: D.latestPeriod, amount: tot });
    }
  }
  // aclaraciones enviadas como observación: el movimiento queda «sin aclarar» y es hallazgo candidato
  const byId = new Map(ms.flatMap(m => allMovs(m).map(x => [x.id, { ...x, period: m.period }])));
  for (const o of opts.observations || []) {
    const mv = o.movementId ? byId.get(o.movementId) : null;
    if (!mv || out.some(a => a.evidence.includes(mv.id))) continue;
    const level = o.blocking ? 'critical' : Number(mv.amount) >= 5000 ? 'moderate' : 'observation';
    add('sin_aclarar', level, 'observation', `Movimiento sin aclarar: «${mv.concept}»`,
      `${mv.date}, ${mv.type} por ${fmtMXN(mv.amount)}. Se envió como observación a la administración: «${o.text}».`, [mv.id], { period: mv.period, amount: mv.amount });
  }
  return out;
}

// ---------- Validación de estructuras (contratos de datos) ----------
const isPeriod = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s));

export function validateMonthMapping(mm) {
  const errs = [];
  if (!mm || typeof mm !== 'object') return ['El mapeo no es un objeto.'];
  if (!isPeriod(mm.period)) errs.push(`Período inválido: ${mm.period}`);
  for (const f of ['initialBalance', 'finalBalance']) if (mm[f] !== null && !Number.isFinite(Number(mm[f]))) errs.push(`${f} no es numérico`);
  if (!Array.isArray(mm.movements)) errs.push('movements debe ser lista');
  const ids = new Set();
  for (const m of [...(mm.movements || []), ...(mm.unclassifiedMovements || [])]) {
    if (!m.id || ids.has(m.id)) errs.push(`Movimiento sin id único (${m.concept})`);
    ids.add(m.id);
    if (!isDate(m.date)) errs.push(`Fecha inválida en ${m.id}: ${m.date}`);
    if (!['cargo', 'abono'].includes(m.type)) errs.push(`Tipo inválido en ${m.id}`);
    if (m.amount !== null && !(Number.isFinite(Number(m.amount)) && Number(m.amount) >= 0)) errs.push(`Monto inválido en ${m.id}`);
    if (!CATEGORY_IDS.includes(m.category)) errs.push(`Categoría desconocida en ${m.id}: ${m.category}`);
    if (typeof m.concept !== 'string') errs.push(`Concepto faltante en ${m.id}`);
  }
  return errs;
}

// Normaliza la salida de "interpret": asegura ids, tipos y categoría válida, sin inventar montos.
export function normalizeInterpretation(raw, fileId, fallbackPeriod) {
  const period = isPeriod(raw?.period) ? raw.period : fallbackPeriod;
  const movs = (Array.isArray(raw?.movements) ? raw.movements : []).map((m, i) => {
    const type = m.type === 'abono' ? 'abono' : m.type === 'cargo' ? 'cargo' : null;
    const amount = num(typeof m.amount === 'string' ? parseAmount(m.amount) : m.amount);
    let category = CATEGORY_IDS.includes(m.category) ? m.category : suggestCategory(m.concept, type);
    if (type === 'cargo' && INCOME_ONLY.has(category)) category = suggestCategory(m.concept, type);
    return {
      id: `${period}-${String(i + 1).padStart(3, '0')}`,
      date: isDate(m.date) ? m.date : `${period}-01`,
      dateUncertain: !isDate(m.date),
      concept: String(m.concept || '').slice(0, 300),
      amount: amount === null ? null : Math.abs(amount),
      type: type || 'cargo',
      category,
      engineSuggestion: suggestCategory(m.concept, type || 'cargo'),
      fund: resolveFund(m.fund, category, m.concept),
      origin: formatOrigin(m.origin) || ((type === 'abono' || REFUND_RE.test(normText(m.concept))) ? extractOrigin(`${m.concept || ''} ${m.sourceText || ''}`) : ''),
      scope: m.scope || '',
      cash: !!m.cash || isCash(m.concept),
      sourcePageNumber: Number.isInteger(m.sourcePageNumber) ? m.sourcePageNumber : null,
      sourceText: String(m.sourceText || m.concept || '').slice(0, 400),
      fileId,
    };
  });
  return recomputeMonth({
    period, fileId,
    bank: raw?.bank || '', accountType: raw?.accountType || '', currency: raw?.currency || 'MXN',
    periodStart: isDate(raw?.periodStart) ? raw.periodStart : null, periodEnd: isDate(raw?.periodEnd) ? raw.periodEnd : null,
    initialBalance: num(raw?.initialBalance), finalBalance: num(raw?.finalBalance),
    reportedIncome: num(raw?.reportedIncome), reportedExpense: num(raw?.reportedExpense),
    pettyCashBalance: num(raw?.pettyCashBalance),
    movements: movs, unclassifiedMovements: [],
    aiQuestions: (Array.isArray(raw?.questions) ? raw.questions : []).map((q, i) => ({ id: `q-ai-${period}-${i + 1}`, period, prompt: String(q.prompt || q.question || ''), observationDraft: String(q.observation || '').slice(0, 600), blocking: !!q.blocking, kind: 'text', movementRef: q.movementIndex ?? null, movementId: linkQuestionMovement(q.prompt || q.question, Number.isInteger(q.movementIndex) ? q.movementIndex : null, movs) })).filter(q => q.prompt),
    notes: Array.isArray(raw?.notes) ? raw.notes.map(normalizeNote).filter(n => n.detail) : [],
    delinquency: normalizeDelinquency(raw?.delinquency, period) || { found: false, asOf: null, reportedTotal: null, rows: [] },
  });
}

// ---------- Rol de quien hace la revisión ----------
export const ROLES = {
  condomino: { label: 'Condómino', reviewer: 'Condómino revisor', desc: 'Revisas el estado de cuenta que entrega la administración y le haces observaciones.', note: 'Escrito de observaciones a la administración', questions: 'Preguntas a la administración', obsPanel: 'Observaciones para la administración', obsAction: 'Enviar como observación a la administración' },
  comite: { label: 'Miembro del Comité de Vigilancia', reviewer: 'Miembro del Comité de Vigilancia', desc: 'Vigilas la gestión de la administración y detectas inconsistencias para el Comité.', note: 'Nota de alerta para el Comité de Vigilancia', questions: 'Preguntas para el administrador en la próxima reunión', obsPanel: 'Observaciones para la administración', obsAction: 'Enviar como observación a la administración' },
  admin: { label: 'Administrador', reviewer: 'Administrador', desc: 'Revisas tu propio estado de cuenta antes de presentarlo al Comité y a la Asamblea.', note: 'Puntos a corregir antes de presentar el estado de cuenta', questions: 'Puntos a verificar con soporte documental', obsPanel: 'Puntos pendientes anotados', obsAction: 'Dejar pendiente (anotar)' },
};
export const roleOf = r => ROLES[r] || ROLES.condomino;

// Observaciones de lectura de Claude: {kind, title, detail}. Acepta también texto suelto (versiones anteriores).
export const NOTE_KINDS = {
  inconsistencia: { label: 'Inconsistencias por revisar', one: 'inconsistencia', many: 'inconsistencias', order: 1 },
  hipotesis: { label: 'Hipótesis', one: 'hipótesis', many: 'hipótesis', order: 2 },
  lectura: { label: 'Cómo se leyó el documento', one: 'nota de lectura', many: 'notas de lectura', order: 3 },
  verificacion: { label: 'Verificaciones que cuadran', one: 'verificación', many: 'verificaciones', order: 4 },
};
export function normalizeNote(n) {
  if (n && typeof n === 'object') {
    const kind = NOTE_KINDS[n.kind] ? n.kind : classifyNote(`${n.title || ''} ${n.detail || ''}`);
    return { kind, title: String(n.title || '').trim().slice(0, 120), detail: String(n.detail || n.text || '').trim().slice(0, 1200) };
  }
  const t = String(n || '').trim();
  const m = t.match(/^([^:.]{6,70}):\s+(.+)$/s);
  return { kind: classifyNote(t), title: m ? m[1].trim() : '', detail: m ? m[2].trim() : t };
}
function classifyNote(t) {
  const x = normText(t);
  if (/HIPOTESIS|SUGIERE|POSIBLE(MENTE)?\b|PODRIA/.test(x)) return 'hipotesis';
  if (/ERROR|INCONSISTEN|NO COINCIDE|DISCREPAN|REPITE|EN LUGAR DE|DISTINTO|DIFIERE|NO SE PUDO|FALTA|DEBE REVISARSE/.test(x)) return 'inconsistencia';
  if (/\bCUADRA|COINCIDE|CORRECT/.test(x)) return 'verificacion';
  return 'lectura';
}

export function validateFindings(findings, movementIds, { min = 3, max = 6 } = {}) {
  const errs = [];
  if (!Array.isArray(findings)) return ['findings debe ser lista'];
  if (findings.length < min || findings.length > max) errs.push(`Se esperaban entre ${min} y ${max} hallazgos; llegaron ${findings.length}.`);
  const ids = new Set();
  for (const f of findings) {
    if (!f.id || ids.has(f.id)) errs.push(`Hallazgo sin id único: ${f.title}`);
    ids.add(f.id);
    if (!f.title || !f.description) errs.push(`Hallazgo ${f.id} incompleto`);
    if (!LEVELS.includes(f.level)) errs.push(`Nivel inválido en ${f.id}`);
    if (!Array.isArray(f.evidence) || !f.evidence.length) errs.push(`Hallazgo ${f.id} sin evidencia`);
    else for (const e of f.evidence) if (!movementIds.has(e)) errs.push(`Hallazgo ${f.id} referencia un movimiento no confirmado: ${e}`);
  }
  return errs;
}

export function validateReport(rep, selectedIds) {
  const errs = [];
  if (!rep || typeof rep !== 'object') return ['Reporte vacío'];
  if (!rep.executiveSummary || String(rep.executiveSummary).trim().length < 40) errs.push('Falta el resumen ejecutivo.');
  if (!Array.isArray(rep.findings)) errs.push('Faltan hallazgos.');
  else {
    const got = rep.findings.map(f => f.id);
    if (!got.length || got.length !== selectedIds.length || got.some((id, i) => id !== selectedIds[i])) errs.push(`Los hallazgos del reporte (${got.join(', ')}) no coinciden con la selección (${selectedIds.join(', ')}).`);
    for (const f of rep.findings) if (!f.recommendation && !f.missingData) errs.push(`Hallazgo ${f.id} sin recomendación ni datos faltantes.`);
  }
  if (!rep.limitations) errs.push('Falta la sección de limitaciones.');
  return errs;
}

export function validateAlert(al, selectedIds) {
  const errs = [];
  if (!al || typeof al !== 'object') return ['Nota vacía'];
  for (const f of ['addressee', 'sender', 'reference', 'body', 'legalWarning']) if (!al[f] || !String(al[f]).trim()) errs.push(`Falta ${f} en la nota.`);
  if (!Array.isArray(al.findings) || al.findings.map(f => f.id).join() !== selectedIds.join()) errs.push('La nota debe tratar todos los hallazgos seleccionados, en el orden seleccionado.');
  if (!Array.isArray(al.questionsForCommittee) || al.questionsForCommittee.length !== 3) errs.push('La nota debe incluir exactamente tres preguntas para el Comité.');
  if (al.legalWarning && !/39/.test(al.legalWarning)) errs.push('La advertencia final debe citar el artículo 39 de la LPCIDF.');
  return errs;
}

export function hashMapping(months) {
  const s = JSON.stringify(sortMonths(months).map(m => [m.period, m.initialBalance, m.finalBalance, allMovs(m).map(x => [x.id, x.amount, x.type, x.category, x.date])]));
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
