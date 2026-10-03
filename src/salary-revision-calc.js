// Pure: all Salary Revision Planner maths — sequential rule application to
// simulated per-employee salaries, org-wide + per-group (department/equal
// work group) median & mean pay-gap comparison (current vs. simulated), and
// the monthly/annual budget impact (with an optional Swedish payroll-tax
// markup). No DOM and no browser-global dependencies.
//
// Rule shape: { scope: 'All'|'Department'|'Equal Work Group'|'Level',
//               scopeValue: string, gender: 'All'|'Female'|'Male',
//               valueType: 'percentage'|'flat', value: number }
// Rules are applied SEQUENTIALLY (each on top of the previous rule's result)
// to every employee they match — see docs/salary-revision-planner-spec.md §3.

// Swedish employer social-security contribution ("arbetsgivaravgift") — the
// spec's suggested optional budget markup (§3.B.3).
const SR_PAYROLL_TAX_RATE = 0.3142;

function srScopeField(scope) {
  if (scope === 'Department') return 'DEPARTMENT';
  if (scope === 'Equal Work Group') return 'EQUAL WORK GROUP';
  if (scope === 'Level') return 'LEVEL';
  return null; // 'All' (or unrecognized) -> no scope filter
}

function ruleMatchesEmployee(rule, emp) {
  if (!rule || !emp) return false;
  const field = srScopeField(rule.scope);
  if (field && String(emp[field] == null ? '' : emp[field]) !== String(rule.scopeValue == null ? '' : rule.scopeValue)) {
    return false;
  }
  const gender = rule.gender || 'All';
  // #2462 — a 'Female' rule matches "female" / " FEMALE " too (shared reader).
  if (gender !== 'All' && __basisSr.normalizeGender(emp['GENDER']) !== gender) return false;
  return true;
}

// Applies ONE rule to a current salary. `fte` (FULL-TIME EQ.) only matters for
// a flat adjustment: a flat amount is defined at full-time-equivalent, so a
// part-timer's actual monthly increase is prorated by their FTE (spec
// example: 1000 kr flat at FTE 0.8 -> actual salary rises by 800 kr).
// A percentage adjustment applies directly to the (already FTE-scaled)
// current salary, no extra FTE factor.
// Clamped to >= 0 at every step (not just the final result): rules apply
// SEQUENTIALLY and cumulatively, so several individually-valid rules (each
// bounded to +-200% / +-1,000,000 SEK) can still stack into a large negative
// number for one employee if applied unclamped — a negative salary is never
// meaningful and would silently corrupt every downstream pay-gap calculation.
function applyRuleToSalary(currentSalary, fte, rule) {
  const value = parseFloat(rule && rule.value) || 0;
  const f = (typeof fte === 'number' && isFinite(fte) && fte > 0) ? fte : (parseFloat(fte) || 1);
  const result = (rule && rule.valueType === 'flat')
    ? currentSalary + (value * (f || 1))
    : currentSalary * (1 + value / 100); // 'percentage' (default)
  return Math.max(0, result);
}

// Returns a NEW array (same length/order) with 'BASE SALARY' replaced by the
// simulated value for every employee at least one rule matched; untouched
// employees are returned as the SAME object reference (cheap "did it change"
// check via ===). Rules are applied in array order, cumulatively.
function computeSimulatedEmployees(employees, rules) {
  const safeRules = Array.isArray(rules) ? rules : [];
  return (employees || []).map((emp) => {
    if (!emp) return emp;
    // #2350 item 6 — the shared FULL-TIME EQ. rule, so a legacy stored
    // percentage (80) prorates a flat raise at 0.8, not x80. Missing/invalid
    // -> 1.0, exactly what applyRuleToSalary already fell back to.
    // #2483 D5 (owner decision 2026-09-28): SKIP a row with no valid base
    // salary — never "0 + flat raise" (the #2422 pattern). It stays the same
    // object (untouched, not affected, no budget delta, out of the gap
    // floors) and listSkippedNoBaseSalary reports it so HR can fix the data.
    if (!__basisSr.hasValidBaseSalary(emp)) return emp;
    const fte = __basisSr.resolveFteFractionForAnalysis(emp['FULL-TIME EQ.']);
    let salary = parseFloat(emp['BASE SALARY']) || 0;
    let changed = false;
    safeRules.forEach((rule) => {
      if (ruleMatchesEmployee(rule, emp)) {
        salary = applyRuleToSalary(salary, fte, rule);
        changed = true;
      }
    });
    if (!changed) return emp;
    return Object.assign({}, emp, { 'BASE SALARY': Math.round(salary * 100) / 100 });
  });
}

// #2483 D5 — every employee at least one rule MATCHED but who was skipped
// because they have no valid base salary (pay-equity-basis.js's
// hasValidBaseSalary). Returns [{ email, name }] in roster order — the
// planner shows this list ("skipped – no base salary") and
// applySalaryRevisionAdmin returns it with the apply result.
function listSkippedNoBaseSalary(employees, rules) {
  const safeRules = Array.isArray(rules) ? rules : [];
  if (!safeRules.length) return [];
  const out = [];
  (employees || []).forEach((emp) => {
    if (!emp || __basisSr.hasValidBaseSalary(emp)) return;
    if (!safeRules.some((rule) => ruleMatchesEmployee(rule, emp))) return;
    out.push({ email: String(emp.EMAIL || '').toLowerCase().trim(), name: String(emp.NAME || '') });
  });
  return out;
}

// #2347 — THE canonical include-in-analysis predicate (pay-equity-basis.js,
// absent value = INCLUDED per #2243), the same one createCalculator uses for
// every pay-gap number in this app, so the planner's gap figures are directly
// comparable to the Company Dashboard's. This used to be its own yes/true/1
// whitelist, which silently dropped employees imported without the column.
// The browser loads pay-equity-basis.js before this file; Node require()s it.
const __basisSr = (typeof module !== 'undefined' && module.exports)
  ? require('./pay-equity-basis.js')
  : window;
function srIsActiveForAnalysis(e) {
  return __basisSr.isIncludedInAnalysis(e);
}

function srMean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function srMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median + mean gender pay gap over one employee set. Gap = (median/mean Male
// - median/mean Female) / median/mean Male * 100 — 'N/A' unless both genders
// are represented (mirrors benchmark.js's computeBenchmarkSimulation).
function computeGenderGap(employees) {
  const active = (employees || []).filter(srIsActiveForAnalysis);
  const salOf = (e) => parseFloat(e['BASE SALARY']) || 0;
  // #448: salOf collapses a missing/invalid salary to 0 with NO filter at
  // all — floor it out here (matches calculator.js/deiMerge.js/
  // deiDashboardFns.js's `!isNaN(s) && s > 0` pattern) so a $0/missing BASE
  // SALARY (e.g. a #421 leave-period overlay) can't corrupt the reported gap.
  const positive = (arr) => arr.filter((s) => s > 0);
  // #2462 — the shared, case-insensitive gender reader (pay-equity-basis.js).
  const female = positive(active.filter((e) => __basisSr.isFemaleEmployee(e)).map(salOf));
  const male = positive(active.filter((e) => __basisSr.isMaleEmployee(e)).map(salOf));
  const hasBoth = female.length > 0 && male.length > 0;
  const medianGap = hasBoth ? ((srMedian(male) - srMedian(female)) / srMedian(male)) * 100 : 'N/A';
  const meanGap = hasBoth ? ((srMean(male) - srMean(female)) / srMean(male)) * 100 : 'N/A';
  return { medianGap, meanGap, femaleCount: female.length, maleCount: male.length, totalCount: active.length };
}

// Monthly/annual cost delta between two aligned (same order/length) employee
// arrays, optionally grossed up by the employer payroll-tax rate.
function computeBudgetImpact(currentEmployees, simulatedEmployees, payrollTaxRate) {
  const salOf = (e) => parseFloat(e && e['BASE SALARY']) || 0;
  let monthly = 0;
  const n = Math.min((currentEmployees || []).length, (simulatedEmployees || []).length);
  for (let i = 0; i < n; i++) {
    monthly += salOf(simulatedEmployees[i]) - salOf(currentEmployees[i]);
  }
  const rate = typeof payrollTaxRate === 'number' && payrollTaxRate > 0 ? payrollTaxRate : 0;
  const annual = monthly * 12;
  return {
    monthly,
    annual,
    monthlyWithTax: monthly * (1 + rate),
    annualWithTax: annual * (1 + rate),
    payrollTaxRate: rate
  };
}

// Per-group (Department / Equal Work Group) breakdown: current vs. simulated
// gap for every distinct value seen in the CURRENT data. `currentEmployees`
// and `simulatedEmployees` must be aligned (same order/length) — as returned
// by computeSimulatedEmployees.
function computeGroupBreakdown(currentEmployees, simulatedEmployees) {
  const dims = [
    { type: 'department', field: 'DEPARTMENT' },
    { type: 'equalWorkGroup', field: 'EQUAL WORK GROUP' }
  ];
  const rows = [];
  const current = currentEmployees || [];
  const simulated = simulatedEmployees || [];
  dims.forEach(({ type, field }) => {
    const values = new Set();
    current.forEach((e) => {
      const v = e && e[field];
      if (v !== undefined && v !== null && String(v).trim() !== '') values.add(String(v));
    });
    Array.from(values).sort().forEach((value) => {
      const currGroup = [];
      const simGroup = [];
      current.forEach((e, i) => {
        if (String(e[field]) === value) {
          currGroup.push(e);
          simGroup.push(simulated[i]);
        }
      });
      rows.push({
        type,
        value,
        employeeCount: currGroup.filter(srIsActiveForAnalysis).length,
        current: computeGenderGap(currGroup),
        simulated: computeGenderGap(simGroup)
      });
    });
  });
  return rows;
}

// Classifies a gap's movement for a UI change indicator. Compares magnitude
// (|gap|), since a gap narrowing towards 0 is the goal regardless of sign.
function classifyGapChange(currentGap, simulatedGap) {
  if (currentGap === 'N/A' || simulatedGap === 'N/A') return 'unknown';
  const diff = Math.abs(simulatedGap) - Math.abs(currentGap);
  if (diff < -0.05) return 'improved';
  if (diff > 0.05) return 'worsened';
  return 'unchanged';
}

// Top-level entry point the UI (and applySalaryRevisionAdmin server-side)
// calls: given the org's employees + the rule chain (+ options), returns
// everything Panels 2 & 3 need to render, plus the simulated roster itself
// (what the server would actually persist on Apply).
function computeRevisionSimulation(employees, rules, opts) {
  opts = opts || {};
  const list = employees || [];
  const simulatedEmployees = computeSimulatedEmployees(list, rules);

  let affectedCount = 0;
  for (let i = 0; i < list.length; i++) {
    const before = parseFloat(list[i]['BASE SALARY']) || 0;
    const after = parseFloat(simulatedEmployees[i]['BASE SALARY']) || 0;
    if (Math.abs(after - before) > 0.005) affectedCount++;
  }

  return {
    simulatedEmployees,
    affectedCount,
    skippedNoBaseSalary: listSkippedNoBaseSalary(list, rules),
    current: computeGenderGap(list),
    simulated: computeGenderGap(simulatedEmployees),
    budget: computeBudgetImpact(list, simulatedEmployees, opts.includePayrollTax ? SR_PAYROLL_TAX_RATE : 0),
    groups: computeGroupBreakdown(list, simulatedEmployees)
  };
}

// Node/test interop only (skipped in the browser where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SR_PAYROLL_TAX_RATE,
    ruleMatchesEmployee,
    applyRuleToSalary,
    computeSimulatedEmployees,
    listSkippedNoBaseSalary,
    computeGenderGap,
    computeBudgetImpact,
    computeGroupBreakdown,
    classifyGapChange,
    computeRevisionSimulation
  };
}
