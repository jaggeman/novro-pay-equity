/* ==========================================================================
   PAY-EQUITY COMPARISON BASIS (#2242)

   The shared rules for turning a stored employee record into the figure the
   pay-gap analysis is allowed to COMPARE. Loaded before every calc core in
   index.html and require()d by each of them in Node, so the client-side paths
   (analysis-dashboard.js's createCalculator/updateClassificationTable,
   action-plan.js's computeIndividualDeviations) and the server's results API
   can never disagree about the basis.

   WHY A SHARED MODULE. The variable-pay overlay — the other thing that adjusts
   BASE SALARY before a calculation — is duplicated in four places, each
   carrying a comment promising it mirrors analyticsFns.js's withVariablePay()
   "EXACTLY". That is a toggle, applied per caller, so it was arguably
   defensible. FTE normalisation is UNCONDITIONAL: every comparison, in every
   surface, on both sides of the wire. Four hand-kept copies of an
   unconditional rule is how #2241 and #2243 happened, so this one gets a
   single home from the start. (#2422 then moved the variable-pay overlay here
   too, after those copies all turned out to share the same bug — see
   withVariablePayOverlay.)

   isIncludedInAnalysis lived in classification-table.js until #2242 — a
   misleading home, and it forced any consumer needing BOTH shared rules to
   depend on two files. It is canonical here now; classification-table.js
   re-exports it so existing call sites are untouched.
   ========================================================================== */

// #2243 — is this employee part of the analysis at all? An ABSENT value means
// INCLUDED: the statutory analysis covers the whole workforce, so exclusion is
// a deliberate act that must be recorded explicitly, never the residue of a
// field nobody filled in. Only an explicit negative excludes; an unrecognised
// value is not a deliberate exclusion either. See #2243 for the full rationale
// and the import validator's own warning on unparseable values.
function isIncludedInAnalysis(e) {
  if (!e || typeof e !== 'object') return false;
  const value = e['INCLUDE IN ANALYSIS'];
  if (value === undefined || value === null) return true;
  const stringValue = String(value).trim().toLowerCase();
  if (stringValue === '') return true;
  return !(stringValue === 'no' || stringValue === 'false' || stringValue === '0');
}

// #2242 — resolve FULL-TIME EQ. for COMPARISON purposes. Deliberately a
// different contract from functions/salaryHistory.js's resolveFteFraction,
// which returns null for unusable input and 0 for a stored zero, leaving each
// caller to decide: here every degradation lands on 1.0 (full-time).
//
// Product owner decision, 2026-09-13. Full-time is the employee-favouring
// direction: normalising divides by the fraction, so any value BELOW 1 raises
// the comparison salary. Defaulting to 1.0 therefore never inflates someone's
// figure and so can never manufacture a gap against them — where defaulting to
// a guessed part-time fraction could. Zero is folded in for the same reason
// plus an arithmetic one: dividing by it yields Infinity.
//
// #2350 item 6 — a stored value in (MAX_FTE_FRACTION, 100] is a percentage
// that was imported before the import path learned to convert it (Swedish HR
// files express sysselsättningsgrad as "80"), so it is read as 0.8 here. That
// fixes every org already holding such values without a data migration. An
// out-of-range value (> 100) keeps the full-time fallback above.
function resolveFteFractionForAnalysis(raw) {
  const r = normalizeFteValue(raw);
  return r.valid ? r.value : 1;
}

// #2350 item 6 — THE rule for interpreting a FULL-TIME EQ. value, shared by
// every write path (functions/employee-import-validator.js,
// functions/importFns.js), every reader (resolveFteFractionForAnalysis above,
// functions/salaryHistory.js's resolveFteFraction) and the edit modal's
// back-fill. Product owner decision on #2350:
//   - 0 < v <= MAX_FTE_FRACTION           -> a fraction, kept as given.
//   - MAX_FTE_FRACTION < v <= 100          -> a percentage, v / 100.
//   - an explicit "%" (0 < v <= 100)       -> always a percentage, v / 100.
//   - <= 0, > 100, non-numeric             -> invalid (write paths reject it).
//   - null / undefined / blank string      -> blank ("not provided").
// Accepts "80", "80%", "80 %", "80,5" (sv-SE decimal comma). A value with both
// a comma and a dot, or several commas, is rejected rather than guessed at —
// an employment rate never needs thousands grouping.
//
// MAX_FTE_FRACTION mirrors employee-detail-view.js's own clamp (2 = 200 %,
// real overtime contracts), so everything the edit modal can produce is a
// fraction here too.
//
// Returns { kind: 'fraction'|'percent'|'invalid'|'blank', valid, value }.
// `value` is the fraction to store/use (null unless valid). A converted
// percentage is rounded to 4 decimals, the edit modal's own precision, so
// 80.5 stores as 0.805 rather than 0.8049999….
// Named BASIS_MAX_FTE_FRACTION, not MAX_FTE_FRACTION: this file is a classic
// <script> sharing the global scope with employee-detail-view.js, whose own
// top-level `const MAX_FTE_FRACTION` then threw "already been declared" and
// killed that whole file (classic-script-global-collision-guard.test.js).
var BASIS_MAX_FTE_FRACTION = 2;
var MAX_FTE_PERCENT = 100;
var FTE_NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function normalizeFteValue(raw) {
  var invalid = { kind: 'invalid', valid: false, value: null };
  if (raw === null || raw === undefined) return { kind: 'blank', valid: false, value: null };
  var n;
  var percentSign = false;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    var s = raw.replace(/\s+/g, ''); // \s includes the NBSP sv-SE number formatting uses
    if (s === '') return { kind: 'blank', valid: false, value: null };
    if (s.charAt(s.length - 1) === '%') { percentSign = true; s = s.slice(0, -1); }
    var commas = (s.match(/,/g) || []).length;
    if (commas > 1 || (commas === 1 && s.indexOf('.') !== -1)) return invalid;
    s = s.replace(',', '.');
    if (!FTE_NUMBER_RE.test(s)) return invalid;
    n = Number(s);
  } else {
    return invalid;
  }
  if (!isFinite(n) || n <= 0) return invalid;
  if (!percentSign && n <= BASIS_MAX_FTE_FRACTION) return { kind: 'fraction', valid: true, value: n };
  if (n > MAX_FTE_PERCENT) return invalid;
  return { kind: 'percent', valid: true, value: Math.round((n / 100) * 10000) / 10000 };
}

// The full-time-equivalent salary: what this person would earn at 100 %, which
// is the only figure two employees on different contracts can be compared on.
//
// NOTE the asymmetry this creates, which is intended and must be surfaced in
// the UI: an employee's OWN displayed salary stays what they are actually
// paid, while medians/gaps/flags are computed here. No number in the product
// is then mislabelled — but a view showing both owes the reader a word about
// which basis it is using.
//
// Reads whatever BASE SALARY it is given, so it composes with the variable-pay
// overlay rather than fighting it: fold variable pay first (as the existing
// overlays do) and this normalises the combined figure, which is correct —
// a part-timer's variable pay is earned at part-time too.
//
// A zero/missing/malformed salary returns 0 and is left for each core's own
// existing `> 0` floor to drop (#432/#448); normalisation must not quietly
// promote a $0 row into the sample.
function fteNormalizedSalary(e) {
  const salary = parseFloat(e && e['BASE SALARY']);
  if (isNaN(salary) || salary <= 0) return 0;
  return salary / resolveFteFractionForAnalysis(e && e['FULL-TIME EQ.']);
}

// #2422 — does this record carry a BASE SALARY the analysis may compare? The
// same test every calc core's `> 0` floor applies (parseFloat, finite, > 0),
// named once so the variable-pay overlay below and the "left out" notice can
// ask it too. A missing, blank, malformed, zero or negative base is NOT a
// salary: the row is incomplete and stays out of every pay comparison.
function hasValidBaseSalary(e) {
  if (!e || typeof e !== 'object') return false;
  const salary = parseFloat(e['BASE SALARY']);
  return isFinite(salary) && salary > 0;
}

// #2422 — THE variable-pay overlay ("Include variable pay", #268). Was
// duplicated in the server's analyticsFns.withVariablePay and five browser/
// mock copies, all doing `(parseFloat(BASE SALARY) || 0) + VARIABLE PAY` —
// so a row with NO base salary became 0 + bonus, cleared every core's `> 0`
// floor and entered the pay-gap analysis with a figure that is nobody's
// salary. Now:
//   - toggle off                -> rows returned as given (never copied).
//   - no valid base salary      -> an unchanged COPY: still excluded, exactly
//                                  as in base-only mode. Variable pay can
//                                  never make a row analysable.
//   - valid base                -> base + VARIABLE PAY (a malformed/absent
//                                  variable counts as 0, as before).
// Never mutates the caller's rows.
function withVariablePayOverlay(employees, includeVariablePay) {
  const rows = employees || [];
  if (!includeVariablePay) return rows;
  return rows.map(function (e) {
    if (!e || typeof e !== 'object') return e;
    if (!hasValidBaseSalary(e)) return Object.assign({}, e);
    const variable = parseFloat(e['VARIABLE PAY']) || 0;
    return Object.assign({}, e, { 'BASE SALARY': parseFloat(e['BASE SALARY']) + variable });
  });
}

// #2422 — how many employees the analysis covers by rule (isIncludedInAnalysis)
// but cannot compare because they have no valid base salary. Feeds the
// salary-mapping pages' "left out" banner (filters.js) so the exclusion is
// visible rather than silent.
function countMissingBaseSalary(employees) {
  return (employees || []).reduce(function (n, e) {
    return n + (isIncludedInAnalysis(e) && !hasValidBaseSalary(e) ? 1 : 0);
  }, 0);
}

// Returns COPIES with BASE SALARY replaced by the full-time equivalent — the
// same shape as the variable-pay overlays, deliberately, so a core can apply
// it once at the top and leave the rest of its own maths untouched. Never
// mutates the caller's rows: those still hold the actual paid salary, and a
// consumer that displays an employee's own pay reads them, not this.
function withFteNormalizedSalary(employees) {
  return (employees || []).map(function (e) {
    if (!e || typeof e !== 'object') return e;
    return Object.assign({}, e, { 'BASE SALARY': fteNormalizedSalary(e) });
  });
}

// #2246, converged in #2259 — THE anonymity threshold rule, for every surface
// that redacts a group. This was six independent implementations and four of
// them disagreed: an org storing minTeamSize 1 got full redaction in Individual
// Analysis and Workforce Analytics and NONE in Group Insights, the annual
// snapshot, the EU pay-transparency report, or the OKR pay-equity source. That
// was not a decision anyone took. Product-owner decision, 2026-09-17: floor 3
// everywhere; an org may make anonymity STRICTER, never weaker.
//
// TWO NUMBERS, deliberately not one. Collapsing them silently loosens three
// surfaces, which is why the signature grew a second argument rather than the
// constants being merged:
//
//   MIN_TEAM_SIZE_FLOOR (3) — the compliance boundary. No stored value crosses
//     it, in either direction of carelessness: a group of 1-2 is trivially
//     identifiable, so naming a median inside one IS the identification.
//   `fallback` — what to use when NOTHING is stored, which is per-surface. The
//     three F3 pay-equity disclosure views default to a stricter 5
//     (F3_DEFAULT_MIN_TEAM_SIZE); everything else defaults to the floor.
//
// The three input classes are distinguished on purpose:
//   - absent / cleared (undefined, 0, negative, non-numeric) -> `fallback`.
//     Zero reads as "cleared", not as "I want groups of zero", so it must not
//     drop an F3 view from its stricter 5 down to the bare floor.
//   - a real value below the floor -> the FLOOR, not `fallback`. The org
//     expressed an intent; it is simply not one they may have, so it clamps to
//     the strictest thing they CAN have. This also keeps the scale continuous
//     with the next case (4 with a fallback of 5 stays 4).
//   - a real value at or above the floor -> that value, floored to a whole
//     headcount (a threshold is a count of people; 4.7 is not one).
//
// SEVERITY, for whoever reads this next: a sub-floor value cannot be STORED
// through the supported write path — orgSettingsFns.js rejects it with
// invalid-argument, and every seed writes 3 or 5. This is defence-in-depth
// against a direct Firestore write, a future write path added without that
// check, and the test fixtures that proved the value was reachable at all.
var MIN_TEAM_SIZE_FLOOR = 3;
var F3_DEFAULT_MIN_TEAM_SIZE = 5;

// #2504 — `options.redact === false` (and ONLY an explicit false) is the
// "no internal redaction" mode: a caller the SERVER has found may already see
// individual salaries (canSeeUnredactedPayAnalysis, salaryVisibilityFns.js)
// sees every figure of the internal pay-equity analysis, groups of 1-2
// included — Diskrimineringslagen 3 kap. requires the analysis to cover every
// employee. The disclosure threshold is then one person. Anything else keeps
// the rules above. Use this third argument ONLY where the number gates what
// is DISCLOSED — never for a classification rule that merely shares the
// setting (calculator.js's female-dominated count keeps the plain call).
function resolveMinTeamSize(settings, fallback, options) {
  if (options && options.redact === false) return 1;
  var dflt = MIN_TEAM_SIZE_FLOOR;
  if (typeof fallback === 'number' && isFinite(fallback) && fallback > MIN_TEAM_SIZE_FLOOR) {
    dflt = Math.floor(fallback);
  }
  var n = settings && settings.minTeamSize;
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return dflt;
  if (n < MIN_TEAM_SIZE_FLOOR) return MIN_TEAM_SIZE_FLOOR;
  return Math.floor(n);
}

// #2493 — THE reading of the org's system parameters (settings/global) for
// every analysis surface, client and server alike. Two bugs lived here:
//   - F2: every core read its knobs with `settings.x || default`, so a saved 0
//     (a weight an org deliberately switched off, a 0% pay-gap warning) came
//     back as the default. 0 is a value; only an absent / non-numeric value
//     falls back.
//   - femaleDominatedThreshold is stored 0-100 by the Settings form but 0-1 by
//     seeds and older docs. Some cores normalised it, some did not, and the
//     browser only got a 0-1 share because the "Standard" profile override
//     (F1) happened to replace it. It is always returned here as a 0-1 share.
// minTeamSize goes through resolveMinTeamSize (the anonymity floor) with the
// caller's per-surface fallback. Returns a NEW plain object; never mutates.
//
// #2490 — (B1) the flat experienceImpact / loyaltyImpact / performanceImpact
// weights are phased out: they are no longer system parameters and are not
// resolved here (pay-equity-factors.js reads what an org had stored, for the
// notice and the archive only). (F3/B6) values are held inside their legal
// range when READ, as well as rejected outside it when saved
// (orgSettingsFns.js sanitizeSettings): femaleDominatedThreshold 50-70 %, the
// pay-gap warning 0-100 %. Clamping on read keeps a value stored before B6
// (say 80 %) — or a settingsOverride — from breaking every analysis call,
// and gives every surface the same in-range number.
var SYSTEM_PARAMETER_DEFAULTS = {
  femaleDominatedThreshold: 0.6,
  payGapThreshold: 5,
  minTeamSize: MIN_TEAM_SIZE_FLOOR
};
var FEMALE_DOMINATED_THRESHOLD_RANGE = { min: 0.5, max: 0.7 };

// #2658 — the Swedish analysis pay basis ("lönebegrepp"), an org-level system
// parameter (settings/global.payBasis) the admin picks in Systemparametrar:
//   - 'baseSalary' (DEFAULT, the behaviour before #2658): BASE SALARY only;
//   - 'baseSalaryAndAllowances': BASE SALARY + fixed allowances (ALLOWANCES —
//     the monthly tillägg total, derived from additionalPay when it exists).
// Anything else stored (a typo, a direct write) reads as the default: a basis
// is never guessed. Resolved here, with the other knobs, so every surface —
// the pages, the callables, the REST helpers and the annual snapshot (which
// freezes systemParameters) — reads it the same way. Per legal entity is not
// supported: the Swedish analysis is computed org-wide (one currency scope),
// like every other system parameter; the EU report keeps its own pay concept
// (euPayReportingMetrics.js EU_PAY_CONCEPT) and is not affected.
var PAY_BASIS_BASE = 'baseSalary';
var PAY_BASIS_BASE_AND_ALLOWANCES = 'baseSalaryAndAllowances';
var PAY_BASIS_VALUES = [PAY_BASIS_BASE, PAY_BASIS_BASE_AND_ALLOWANCES];
var DEFAULT_PAY_BASIS = PAY_BASIS_BASE;

function resolvePayBasis(raw) {
  return PAY_BASIS_VALUES.indexOf(raw) !== -1 ? raw : DEFAULT_PAY_BASIS;
}
var PAY_GAP_THRESHOLD_RANGE = { min: 0, max: 100 };

function sysParamNumber(value, dflt) {
  if (value === null || value === undefined || value === '') return dflt;
  var n = Number(value);
  return isFinite(n) ? n : dflt;
}

function resolveSystemParameters(settings, options) {
  var s = settings || {};
  var fallback = options && options.minTeamSizeFallback;
  var fdt = sysParamNumber(s.femaleDominatedThreshold, SYSTEM_PARAMETER_DEFAULTS.femaleDominatedThreshold);
  if (fdt > 1) fdt = fdt / 100;
  if (!(fdt > 0)) fdt = SYSTEM_PARAMETER_DEFAULTS.femaleDominatedThreshold;
  fdt = Math.min(FEMALE_DOMINATED_THRESHOLD_RANGE.max, Math.max(FEMALE_DOMINATED_THRESHOLD_RANGE.min, fdt));
  var pgt = sysParamNumber(s.payGapThreshold, SYSTEM_PARAMETER_DEFAULTS.payGapThreshold);
  pgt = Math.min(PAY_GAP_THRESHOLD_RANGE.max, Math.max(PAY_GAP_THRESHOLD_RANGE.min, pgt));
  var mts = s.minTeamSize;
  if (typeof mts === 'string' && mts.trim() !== '' && isFinite(Number(mts))) mts = Number(mts);
  return {
    femaleDominatedThreshold: fdt,
    payGapThreshold: pgt,
    minTeamSize: resolveMinTeamSize({ minTeamSize: mts }, fallback),
    payBasis: resolvePayBasis(s.payBasis)
  };
}

// The settings object an analysis surface computes with: the org's saved
// settings with the two knobs above resolved in place. minTeamSize is left
// exactly as stored, on purpose — each surface resolves it with its OWN
// fallback (the F3 disclosure views default to 5 when nothing is saved), and
// filling in the floor here would silently loosen those views.
function withSystemParameters(settings) {
  var out = Object.assign({}, settings || {});
  var p = resolveSystemParameters(out);
  out.femaleDominatedThreshold = p.femaleDominatedThreshold;
  out.payGapThreshold = p.payGapThreshold;
  out.payBasis = p.payBasis;
  return out;
}

// #2658 — THE pay-basis overlay for the Swedish analysis. Folds fixed
// allowances into BASE SALARY when the basis says so, then the opt-in
// variable-pay toggle (withVariablePayOverlay) on top. Same guard as that
// overlay: a row without a valid base salary is never made analysable by an
// allowance. With the default basis and variable pay off the input array is
// returned AS GIVEN (same reference), so default output is byte-identical to
// the behaviour before #2658.
//   opts.payBasis           — an explicit basis (wins; e.g. a frozen value);
//   opts.settings           — otherwise read from these (resolveSystemParameters);
//   opts.includeVariablePay — the page's variable-pay toggle.
// Never mutates the caller's rows.
function withAllowancesOverlay(employees, includeAllowances) {
  var rows = employees || [];
  if (!includeAllowances) return rows;
  return rows.map(function (e) {
    if (!e || typeof e !== 'object') return e;
    if (!hasValidBaseSalary(e)) return Object.assign({}, e);
    var a = parseFloat(e.ALLOWANCES);
    var allowances = isFinite(a) && a > 0 ? a : 0;
    return Object.assign({}, e, { 'BASE SALARY': parseFloat(e['BASE SALARY']) + allowances });
  });
}

function withAnalysisPayBasis(employees, opts) {
  var o = opts || {};
  var basis = o.payBasis !== undefined ? resolvePayBasis(o.payBasis) : resolveSystemParameters(o.settings).payBasis;
  var rows = withAllowancesOverlay(employees, basis === PAY_BASIS_BASE_AND_ALLOWANCES);
  return withVariablePayOverlay(rows, !!o.includeVariablePay);
}

// #2658 — the parts the compared figure is made of, for the "Lönebegrepp: …"
// label on every page and in the documentation. Field names, not text: each
// surface maps them to its own i18n keys.
function payBasisComponents(payBasis, includeVariablePay) {
  var out = ['BASE SALARY'];
  if (resolvePayBasis(payBasis) === PAY_BASIS_BASE_AND_ALLOWANCES) out.push('ALLOWANCES');
  if (includeVariablePay) out.push('VARIABLE PAY');
  return out;
}

// #2658 — "Lönebegrepp: grundlön + fasta tillägg" — the label every affected
// page (and the annual snapshot) shows. `translate(key)` is the caller's
// window.t; a missing key falls back to English. Plain text: callers set it
// with textContent or escape it.
var PAY_BASIS_PART_KEYS = {
  'BASE SALARY': ['pay_basis_part_base', 'base salary'],
  'ALLOWANCES': ['pay_basis_part_allowances', 'fixed allowances'],
  'VARIABLE PAY': ['pay_basis_part_variable', 'variable pay']
};
function payBasisTr(translate, key, fallback) {
  var v = typeof translate === 'function' ? translate(key) : null;
  return (!v || v === key) ? fallback : v;
}
// "grundlön + fasta tillägg" (the value alone, e.g. for a CSV cell).
function payBasisPartsText(payBasis, includeVariablePay, translate) {
  return payBasisComponents(payBasis, includeVariablePay).map(function (c) {
    var k = PAY_BASIS_PART_KEYS[c];
    return payBasisTr(translate, k[0], k[1]);
  }).join(' + ');
}
function payBasisLabelText(payBasis, includeVariablePay, translate) {
  return payBasisTr(translate, 'pay_basis_label', 'Pay basis') + ': ' + payBasisPartsText(payBasis, includeVariablePay, translate);
}

// #2462 — THE reading of a GENDER value for every pay comparison. The
// salary-mapping cores compared `GENDER === 'Female'` exactly, so a roster
// holding "female" or " FEMALE " (a direct write, an API client, a legacy
// import) had those employees silently dropped from the Swedish analysis
// while EU reporting (euPayReportingMetrics.js's genderBucket, trimmed and
// case-insensitive) counted them. Trimmed, case-insensitive, plus the same
// single-letter / Swedish aliases the importer accepts
// (employee-import-validator.js normalizeGender: F/K/kvinna/woman, M/man),
// so a value the importer would have stored as "Female" reads as Female here
// too. Returns 'Female' | 'Male' | null — null for blank, "Unknown",
// "Non-binary", "Prefer not to say" and anything unrecognised: those are
// real employees but in neither comparison bucket, exactly as before.
// Bug hunt 7A #7 — the Danish/Norwegian words too (kvinde/kvinne, mand/mann),
// so the Danish § 5 a statistic reads GENDER through this one reader.
var FEMALE_GENDER_ALIASES = ['female', 'f', 'k', 'kvinna', 'woman', 'kvinde', 'kvinne'];
var MALE_GENDER_ALIASES = ['male', 'm', 'man', 'mand', 'mann'];

function normalizeGender(raw) {
  if (raw === null || raw === undefined) return null;
  var g = String(raw).trim().toLowerCase();
  if (g === '') return null;
  if (FEMALE_GENDER_ALIASES.indexOf(g) !== -1) return 'Female';
  if (MALE_GENDER_ALIASES.indexOf(g) !== -1) return 'Male';
  return null;
}

function isFemaleEmployee(e) {
  return normalizeGender(e && e.GENDER) === 'Female';
}

function isMaleEmployee(e) {
  return normalizeGender(e && e.GENDER) === 'Male';
}

// Bug hunt 7A #12 — THE female-dominated rule, shared by the calculator
// (groups), the classification table and Individual Analysis / Group analysis
// (roles): the unit is female-dominated when women make up at least
// `threshold` (0-1) of its HEADCOUNT WITH A SALARY — included in the analysis
// and a BASE SALARY > 0, the same people every pay figure next to it is
// computed over. Calculator and classification used to count everyone
// (salary or not), IA/Gruppanalys only the salaried, so one unit could be
// female-dominated on one page and not on the next.
function countFemaleDominance(employees) {
  var women = 0;
  var total = 0;
  (employees || []).forEach(function (e) {
    if (!isIncludedInAnalysis(e) || !hasValidBaseSalary(e)) return;
    total++;
    if (isFemaleEmployee(e)) women++;
  });
  return { women: women, total: total };
}
function isFemaleDominated(women, total, threshold) {
  return typeof total === 'number' && total > 0 && (women / total) >= threshold;
}

// Bug hunt 7A #11 — THE "justified" predicate, shared by the EU report
// (deiMerge.crossReferenceJustification), the salary-revision guardrail and
// the lönekartläggning start page: a unit is justified only when EVERY
// flagged (required) employee has an OBJECTIVE justification on record now.
// "Unjustified" is a documented finding that the gap is NOT objectively
// justified, so it never counts. An outdated (earlier-year) record still
// counts — #2350 item 1 surfaces it for review instead.
// #2571 — "Factor": a person's gap justified by an explanatory factor
// (factorId@version). A factor only SUGGESTS it; recording it is a human
// decision, so a recorded one counts like any other objective reason.
var OBJECTIVE_JUSTIFICATION_REASONS = ['Experience', 'Performance', 'Market', 'Factor'];
function isObjectiveJustification(j) {
  return !!j && OBJECTIVE_JUSTIFICATION_REASONS.indexOf(j.reason) !== -1;
}

// #2571 B4 — the correction ONE flagged row (computeIndividualDeviations)
// books: its factor-adjusted estimate when the analysis applied factors
// (factorAdjustment.adjustedDiff — the part of the gap the factors do NOT
// explain), the raw gap otherwise. THE rule for every place a correction
// cost is taken from Individuell analys: the Åtgärdsplan, the diffCost the
// browser store keeps (and so withJustificationSimulation) and the
// dashboard's simulation. `target` follows the same choice (the row's own
// `target` when it carries one, else salary + diff). A redacted adjustment
// never invents a number.
// Returns { diff, target, factorAdjusted, explainedPp }.
function correctionGapOf(f) {
  var row = f || {};
  var num = function (v) { return typeof v === 'number' && isFinite(v); };
  var fa = row.factorAdjustment;
  if (fa && !fa.redacted && num(fa.adjustedDiff)) {
    var t = (num(row.target) && num(fa.adjustedTarget)) ? fa.adjustedTarget : (num(row.salary) ? row.salary + fa.adjustedDiff : null);
    return { diff: fa.adjustedDiff, target: t, factorAdjusted: true, explainedPp: num(fa.explainedPp) ? fa.explainedPp : 0 };
  }
  if (!num(row.diff)) return { diff: null, target: null, factorAdjusted: false, explainedPp: 0 };
  return { diff: row.diff, target: num(row.target) ? row.target : (num(row.salary) ? row.salary + row.diff : null), factorAdjusted: false, explainedPp: 0 };
}
// requiredEmails: the flagged people; justByEmail: a Map (or plain object)
// keyed by lowercased email.
function justificationCoverage(requiredEmails, justByEmail) {
  var seen = {};
  var required = [];
  (Array.isArray(requiredEmails) ? requiredEmails : []).forEach(function (e) {
    var k = String(e == null ? '' : e).toLowerCase().trim();
    if (k && !seen[k]) { seen[k] = true; required.push(k); }
  });
  var get = function (k) {
    if (!justByEmail) return null;
    return typeof justByEmail.get === 'function' ? justByEmail.get(k) : justByEmail[k];
  };
  var justified = required.filter(function (k) { return isObjectiveJustification(get(k)); }).length;
  return { requiredCount: required.length, justifiedCount: justified, fullyJustified: required.length > 0 && justified === required.length };
}

// #2439 — the Overview's "Simulate action plan" overlay: every saved
// "Unjustified" justification's diffCost is added to that employee's base
// salary. Same shape and the same guard as withVariablePayOverlay (#2422):
// only a row the analysis could ALREADY compare — included by rule
// (isIncludedInAnalysis) and carrying a valid base (hasValidBaseSalary) — is
// adjusted. A justification saved before the employee's base salary was
// removed is stale; applying it made 0 + diffCost their whole "salary" and
// put a person with no salary back into the simulated analysis.
// `justifications` is { email -> { reason, diffCost } }, looked up by the
// row's EMAIL as stored and lower-cased. Adjusted rows are copies; every
// other row is returned as the same object. Never mutates the input.
//
// `opts.year` (optional) — how far into the justification's correction plan
// to simulate: 'final' / absent = the plan's end state (the whole diffCost,
// i.e. the target salary the Åtgärdsplan corrects to); a year number k = the
// cumulative share of the plan's yearly split paid out by the end of year k
// (correctionFractionForYear). diffCost is ACTUAL money (the correction the
// plan books, already scaled by the employee's FTE fraction — see
// individual-analysis.js #2242), so it is added to the actual BASE SALARY; the
// FTE-normalised analysis then divides both by the same fraction, landing a
// part-timer exactly on the full-time-equivalent target.
function withJustificationSimulation(employees, justifications, opts) {
  var rows = employees || [];
  var map = justifications || {};
  var year = opts && opts.year;
  return rows.map(function (e) {
    if (!e || typeof e !== 'object') return e;
    var email = e.EMAIL;
    var j = map[email] || map[String(email || '').toLowerCase()];
    if (!j || j.reason !== 'Unjustified') return e;
    var cost = parseFloat(j.diffCost) * correctionFractionForYear(j, year);
    if (!(cost > 0)) return e;
    if (!isIncludedInAnalysis(e) || !hasValidBaseSalary(e)) return e;
    return Object.assign({}, e, { 'BASE SALARY': parseFloat(e['BASE SALARY']) + cost });
  });
}

// The correction plan attached to a justification, in one shape: { years,
// splits } (splits = yearly percentages). Reads both stores' shapes exactly as
// action-plan.js renders them: the server doc's correctionPlan { years,
// yearlySplitPct } (payEquityJustificationsServer on) and the browser store's
// { duration, splits } (flag off). No plan = the Åtgärdsplan's own default,
// 3 years at 34/33/33.
var DEFAULT_CORRECTION_YEARS = 3;
var DEFAULT_CORRECTION_SPLITS = [34, 33, 33];
function correctionPlanOf(j) {
  var years = null;
  var splits = null;
  if (j && j.correctionPlan && typeof j.correctionPlan === 'object') {
    years = j.correctionPlan.years;
    splits = j.correctionPlan.yearlySplitPct;
  } else if (j) {
    years = j.duration;
    splits = j.splits;
  }
  years = parseInt(years, 10);
  if (!(years >= 1)) years = DEFAULT_CORRECTION_YEARS;
  if (!Array.isArray(splits) || !splits.length) splits = DEFAULT_CORRECTION_SPLITS;
  return { years: years, splits: splits.map(function (p) { var n = parseFloat(p); return isFinite(n) && n > 0 ? n : 0; }) };
}

// Share (0..1) of a justification's diffCost corrected by the end of `year`.
// 'final' / absent / a year at or past the plan's length = 1 (the plan's end
// state is the full target, whatever rounding its split carries); before that,
// the cumulative yearly split, capped at 1.
function correctionFractionForYear(j, year) {
  if (year === undefined || year === null || year === 'final') return 1;
  var k = parseInt(year, 10);
  if (!(k >= 1)) return 1;
  var plan = correctionPlanOf(j);
  if (k >= plan.years) return 1;
  var pct = 0;
  for (var i = 0; i < k && i < plan.splits.length; i++) pct += plan.splits[i];
  return Math.min(1, pct / 100);
}

if (typeof window !== 'undefined') {
  window.isIncludedInAnalysis = isIncludedInAnalysis;
  window.resolveFteFractionForAnalysis = resolveFteFractionForAnalysis;
  window.normalizeFteValue = normalizeFteValue;
  window.fteNormalizedSalary = fteNormalizedSalary;
  window.withFteNormalizedSalary = withFteNormalizedSalary;
  window.hasValidBaseSalary = hasValidBaseSalary;
  window.withVariablePayOverlay = withVariablePayOverlay;
  window.countMissingBaseSalary = countMissingBaseSalary;
  window.resolveMinTeamSize = resolveMinTeamSize;
  window.MIN_TEAM_SIZE_FLOOR = MIN_TEAM_SIZE_FLOOR;
  window.F3_DEFAULT_MIN_TEAM_SIZE = F3_DEFAULT_MIN_TEAM_SIZE;
  window.normalizeGender = normalizeGender;
  window.isFemaleEmployee = isFemaleEmployee;
  window.isMaleEmployee = isMaleEmployee;
  window.countFemaleDominance = countFemaleDominance;
  window.isFemaleDominated = isFemaleDominated;
  window.OBJECTIVE_JUSTIFICATION_REASONS = OBJECTIVE_JUSTIFICATION_REASONS;
  window.isObjectiveJustification = isObjectiveJustification;
  window.correctionGapOf = correctionGapOf;
  window.justificationCoverage = justificationCoverage;
  window.withJustificationSimulation = withJustificationSimulation;
  window.resolveSystemParameters = resolveSystemParameters;
  window.withSystemParameters = withSystemParameters;
  window.SYSTEM_PARAMETER_DEFAULTS = SYSTEM_PARAMETER_DEFAULTS;
  window.FEMALE_DOMINATED_THRESHOLD_RANGE = FEMALE_DOMINATED_THRESHOLD_RANGE;
  window.correctionPlanOf = correctionPlanOf;
  window.correctionFractionForYear = correctionFractionForYear;
  window.PAY_BASIS_VALUES = PAY_BASIS_VALUES;
  window.DEFAULT_PAY_BASIS = DEFAULT_PAY_BASIS;
  window.resolvePayBasis = resolvePayBasis;
  window.withAllowancesOverlay = withAllowancesOverlay;
  window.withAnalysisPayBasis = withAnalysisPayBasis;
  window.payBasisComponents = payBasisComponents;
  window.payBasisLabelText = payBasisLabelText;
  window.payBasisPartsText = payBasisPartsText;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isIncludedInAnalysis, resolveFteFractionForAnalysis, normalizeFteValue, MAX_FTE_FRACTION: BASIS_MAX_FTE_FRACTION, fteNormalizedSalary, withFteNormalizedSalary, hasValidBaseSalary, withVariablePayOverlay, countMissingBaseSalary, resolveMinTeamSize, MIN_TEAM_SIZE_FLOOR, F3_DEFAULT_MIN_TEAM_SIZE, normalizeGender, isFemaleEmployee, isMaleEmployee, countFemaleDominance, isFemaleDominated, OBJECTIVE_JUSTIFICATION_REASONS, isObjectiveJustification, correctionGapOf, justificationCoverage, withJustificationSimulation, resolveSystemParameters, withSystemParameters, SYSTEM_PARAMETER_DEFAULTS, FEMALE_DOMINATED_THRESHOLD_RANGE, PAY_GAP_THRESHOLD_RANGE, correctionPlanOf, correctionFractionForYear, PAY_BASIS_VALUES, DEFAULT_PAY_BASIS, resolvePayBasis, withAllowancesOverlay, withAnalysisPayBasis, payBasisComponents, payBasisLabelText, payBasisPartsText };
}
