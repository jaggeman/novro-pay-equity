/**
 * functions/euPayReportingMetrics.js — the Directive (EU) 2023/970 art. 9(1)
 * reporting items the existing EU report could not produce. PURE: no I/O, no
 * Firestore, no callables (see euPayTransparencyFns.js for the callable that
 * consumes this).
 *
 * WHY A NEW MODULE RATHER THAN MORE OF deiMerge.js. deiMerge.js's
 * buildEuPayTransparencyReport covers art. 9(1)(a) (the gap), (c) (the median
 * gap) and part of (g) (by category of worker), all computed on "BASE SALARY".
 * It structurally CANNOT produce the four items below, because variable pay
 * only ever reaches the analysis through analyticsFns.withVariablePay, which
 * FOLDS it into "BASE SALARY" before any calculator sees it — deliberately, so
 * every existing anonymity gate covers the total-comp number for free, but it
 * means nothing downstream can separate the two components again:
 *
 *   (b) the gender pay gap in complementary or variable components
 *   (d) the median gender pay gap in those components
 *   (e) the proportion of women and men RECEIVING them
 *   (f) the proportion of women and men in each quartile pay band
 *
 * Quartiles did not exist anywhere in this codebase before this module.
 *
 * ANONYMITY. A quartile band is about a quarter of the workforce, so in a small
 * org every band can sit under the threshold, and a band's gender split is
 * precisely the small-n disclosure #2259 spent a whole slice converging on one
 * rule. Both builders below therefore go through resolveMinTeamSize (the FLOOR
 * — an org can be stricter, never weaker) and mirror
 * payEquitySnapshot.js's redactClassificationRow: a split is disclosed only
 * when BOTH genders independently clear the threshold, never merely the band
 * total. Over-redacting is safe here; under-redacting is the whole risk.
 *
 * GENDER BUCKETING uses workforce-analytics-calc.js's genderBucket convention
 * (trimmed, case-insensitive, everything unrecognised -> "other"), NOT
 * deiMerge.js's computeMedianPay, which compares `GENDER === "Female"` exactly
 * and so silently drops "female" or " Female ". The weaker one is not copied in
 * here on purpose, and a test pins that.
 *
 * GAP DIRECTION follows the convention already established by
 * classifyEuPayCategory: a "womensPctOfMen" where 100 is parity, and the gap
 * reported as (100 - pct), retaining direction in percentage points.
 */
"use strict";

const { resolveMinTeamSize, MIN_TEAM_SIZE_FLOOR, resolveFteFractionForAnalysis, normalizeGender } =
  require("./pay-equity-basis.js");
const { isIncludedInAnalysis, normalizeFteValue } =
  require("./pay-equity-basis.js");

const QUARTILE_COUNT = 4;

// #2462 — delegates to THE shared gender reader (pay-equity-basis.js
// normalizeGender), so EU reporting and the Swedish salary-mapping cores can
// never bucket the same employee differently again.
function genderBucket(g) {
  const v = normalizeGender(g);
  if (v === "Female") return "female";
  if (v === "Male") return "male";
  return "other"; // "Unknown", blank, anything unrecognised
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// #2345 — every figure here is compared on the FULL-TIME-EQUIVALENT basis the
// rest of the pay-equity analysis uses (pay-equity-basis.js, #2242):
// createCalculator normalises the category means, and computeMedianPay the
// medians, so ranking part-timers by their actual (part-time) pay put them in
// the bottom quartile and compared their pro-rated bonuses against full-time
// ones — manufacturing gaps the category table itself doesn't show. The same
// resolveFteFractionForAnalysis rule (every degradation -> 1.0, never a
// guessed fraction) is reused, not re-implemented. A part-timer's variable pay
// is earned at part-time too, so it is normalised by the same fraction (the
// "fold first, then normalise" note in pay-equity-basis.js).
function fteFraction(e) {
  return resolveFteFractionForAnalysis(e && e["FULL-TIME EQ."]);
}

// Bug hunt 7A #4 — the directive's pay concept (art. 3(1)(a): ordinary basic
// pay AND any other consideration, "complementary or variable components")
// includes allowances. ALLOWANCES (tillägg) used to be left out of every EU
// figure, while the Danish statistic already included them. The Swedish
// analysis basis is unchanged (base salary; variable pay only on its opt-in
// toggle) — this concept is the EU report's own, and the report records it.
const EU_PAY_CONCEPT = Object.freeze({
  basePay: "BASE SALARY",
  complementaryComponents: Object.freeze(["VARIABLE PAY", "ALLOWANCES"]),
  categoryGapBasis: "BASE SALARY",
  quartileBasis: "BASE SALARY + VARIABLE PAY + ALLOWANCES",
  fullTimeEquivalent: true
});

// The complementary component: variable pay + allowances (monthly, each part
// counted only when positive).
function complementaryRaw(e) {
  const v = num(e && e["VARIABLE PAY"]);
  const a = num(e && e.ALLOWANCES);
  return (v !== null && v > 0 ? v : 0) + (a !== null && a > 0 ? a : 0);
}

// "Pay" for banding purposes is TOTAL pay — base plus the complementary
// component, full-time equivalent. The directive's quartile bands are about
// what people earn, and a bonus or an allowance legitimately moves someone
// between bands.
function totalPay(e) {
  const base = num(e && e["BASE SALARY"]);
  if (base === null || base <= 0) return null;
  return (base + complementaryRaw(e)) / fteFraction(e);
}

// Full-time-equivalent complementary pay (variable + allowances). Whether
// someone RECEIVES it (item (e)) is unchanged by normalising — only the
// amount is.
function variableOf(e) {
  const v = complementaryRaw(e);
  return v > 0 ? v / fteFraction(e) : 0;
}

function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// One decimal is enough for a disclosure figure and avoids float noise in the
// output; the same rounding deiMerge.js's own `round` applies.
function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}
function ratioPct(a, b) {
  if (a === null || b === null || !b) return null;
  return Math.round((a / b) * 1000) / 10;
}

// The population any of these metrics may be computed over: included in the
// statutory analysis, with a usable pay figure.
function eligible(employees) {
  return (Array.isArray(employees) ? employees : [])
    .filter((e) => e && typeof e === "object" && isIncludedInAnalysis(e) && totalPay(e) !== null);
}

// #2424 — the tie rule, recorded on every result (and every archived copy) so
// the report states which method produced its bands.
const QUARTILE_TIE_METHOD = "proportional";

// Pay is compared at öre precision when grouping ties. The FTE division
// leaves IEEE-754 noise (42000 / 0.7 === 60000.00000000001), and a strict
// comparison would rank that part-timer above an exact 60 000 — putting the
// storage-order problem straight back.
function payKey(pay) {
  return Math.round(pay * 100);
}

// Sums of fractional seats (e.g. 2/3 + 2/3 + 2/3) pick up float noise; this
// removes it without rounding the figure for presentation.
function clean(x) {
  return Math.round(x * 1e9) / 1e9;
}

/**
 * art. 9(1)(f) — the proportion of women and men in each quartile pay band.
 *
 * Method: rank the eligible population by ascending TOTAL pay and split it into
 * four bands as equal in size as possible, distributing any remainder to the
 * LOWER bands first (10 people -> 3/3/2/2). The band SIZES are therefore fixed
 * by headcount alone, and the anonymity gate below (which reads only the band
 * size) is unaffected by how ties are handled.
 *
 * TIES ACROSS A BOUNDARY (#2424) — proportional allocation. People on the same
 * total pay are one group. When a group straddles a band boundary, it is
 * spread across the bands it covers in proportion to the seats it takes in
 * each, and every seat carries the group's OWN gender mix. Example: a tie of 4
 * (2 women, 2 men) taking 1 seat in Q1 and 3 in Q2 adds 0.5 women + 0.5 men to
 * Q1 and 1.5 + 1.5 to Q2. So band counts can be fractional, but they always
 * sum to the band size, and each person counts exactly once across the four
 * bands.
 *
 * Why this rule. Before #2424 the tied group was cut by sort position, and a
 * stable sort keeps Firestore's return order for equal pay — so with 8 women
 * and 8 men on one salary, one storage order reported "bottom half 100 %
 * women" and the reverse order reported the opposite. Any per-person
 * tie-break (email, doc id, a hash) would be deterministic but just as
 * arbitrary: it would still decide by an irrelevant key which gender sits
 * below the line. Gender is never a tie-break, because that would bias the
 * very figure being reported. Distributing a tied group evenly by gender
 * across the boundary is the approach used in statutory quartile reporting
 * (e.g. the UK gender pay gap guidance), and it is identical for every
 * permutation of the input: the groups are ordered by pay, and each group's
 * gender counts do not depend on row order. A tie wholly inside one band, or
 * no ties at all, gives exactly the integer result position slicing gave.
 *
 * The consequence to be aware of: a named individual on a tied pay is not "in"
 * a single band. Nothing in the report lists individuals, so nothing needs to
 * say which one.
 */
function buildPayQuartiles(employees, opts) {
  const threshold = resolveMinTeamSize(opts || {});

  // Group by pay (öre precision), counting genders per group. Row order does
  // not reach anything below this point.
  const groupsByKey = new Map();
  for (const e of eligible(employees)) {
    const key = payKey(totalPay(e));
    let g = groupsByKey.get(key);
    if (!g) { g = { key, size: 0, female: 0, male: 0, other: 0 }; groupsByKey.set(key, g); }
    g.size += 1;
    g[genderBucket(e.GENDER)] += 1;
  }
  const groups = Array.from(groupsByKey.values()).sort((a, b) => a.key - b.key);

  const total = groups.reduce((a, g) => a + g.size, 0);
  // Band sizes: base size for all, remainder spread over the lowest bands.
  const baseSize = Math.floor(total / QUARTILE_COUNT);
  const remainder = total % QUARTILE_COUNT;
  const bands = [];
  let start = 0;
  for (let i = 0; i < QUARTILE_COUNT; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    bands.push({ start, end: start + size, size, female: 0, male: 0, other: 0 });
    start += size;
  }

  // Each group occupies seats [gStart, gEnd) of the ranking; give each band the
  // share of the group's gender mix that matches the seats it overlaps.
  let gStart = 0;
  for (const g of groups) {
    const gEnd = gStart + g.size;
    for (const b of bands) {
      const seats = Math.min(gEnd, b.end) - Math.max(gStart, b.start);
      if (seats <= 0) continue;
      b.female += (seats * g.female) / g.size;
      b.male += (seats * g.male) / g.size;
      b.other += (seats * g.other) / g.size;
    }
    gStart = gEnd;
  }

  const quartiles = [];
  for (let i = 0; i < QUARTILE_COUNT; i++) {
    const b = bands[i];
    const women = clean(b.female);
    const men = clean(b.male);
    const other = clean(b.other);
    const row = { quartile: i + 1, total: b.size };
    // GATED ON THE BAND TOTAL ONLY — deliberately NOT the two-part rule
    // redactClassificationRow uses, and the difference is the point.
    //
    // There, the disclosed figure is a GENDERED PAY MEDIAN: a statistic over one
    // gender's subgroup, so that subgroup must itself clear the floor or the
    // number IS that subgroup's pay. Here the disclosed figure is a PROPORTION
    // OF THE BAND, and the band is the group being described — "this band of 25
    // is 80% women" identifies nobody, while the same sentence about a band of 3
    // does. So the band is what must clear the floor.
    //
    // Requiring each gender to clear it independently was the first thing I
    // wrote, and it is wrong in a way worth recording: a band that is ALL women
    // could then never be disclosed, so the rule would suppress precisely the
    // finding this reporting item exists to surface (gender concentration at the
    // top and bottom of the pay distribution). An anonymity rule that hides the
    // headline result is not protecting anyone, it is defeating the disclosure.
    //
    // Weaker than redactClassificationRow, then, but on a weaker disclosure: a
    // band is a quarter-of-the-distribution range, not a figure, and this app
    // already publishes the org-wide gender split un-redacted
    // (workforce-analytics-calc.js's computeGenderDistribution, "org-wide totals
    // are fine", #265) — quartile proportions are a refinement of that, over
    // groups that each clear the floor.
    const safe = b.size >= threshold;
    if (!safe) {
      row.redacted = true;
    } else {
      row.redacted = false;
      row.women = women;
      row.men = men;
      row.other = other;
      row.womenPct = pct(women, b.size);
      row.menPct = pct(men, b.size);
    }
    quartiles.push(row);
  }
  return { quartiles, totalIncluded: total, thresholdUsed: threshold, tieMethod: QUARTILE_TIE_METHOD };
}

/**
 * art. 9(1)(b)(d)(e) — the variable/complementary component on its own.
 *
 * (e) receivingWomenPct / receivingMenPct are proportions of each gender's WHOLE
 * population, so they survive a redacted gap — that is the item's own meaning
 * ("the proportion of female and male workers receiving…"), and it is the figure
 * that distinguishes "women get smaller bonuses" from "women get none".
 *
 * (b)/(d) are computed over RECIPIENTS only. Averaging the non-recipients' zeros
 * in would conflate the two findings and understate the gap among the people who
 * actually receive variable pay — and (e) already discloses who receives any.
 * This is a real interpretive choice, so it is named here and pinned by a test
 * rather than left implicit in the arithmetic.
 */
function buildVariablePayMetrics(employees, opts) {
  const threshold = resolveMinTeamSize(opts || {});
  const pool = eligible(employees).map((e) => ({
    bucket: genderBucket(e.GENDER),
    variable: variableOf(e)
  }));

  const women = pool.filter((x) => x.bucket === "female");
  const men = pool.filter((x) => x.bucket === "male");
  const womenRecipients = women.filter((x) => x.variable > 0).map((x) => x.variable);
  const menRecipients = men.filter((x) => x.variable > 0).map((x) => x.variable);
  const anyVariablePay = womenRecipients.length + menRecipients.length > 0;

  const out = {
    anyVariablePay,
    thresholdUsed: threshold,
    // (e). Reported only while each gender's own population clears the floor —
    // "1 of 1 women receives a bonus" is a disclosure about one person.
    // #2344 — SUPPRESSED is null, never 0: the page printed a suppressed 0 as
    // a real "0 %", i.e. "no woman receives variable pay" in a compliance
    // report, when the truth was "hidden". The UI renders null as the
    // anonymity chip. A genuine 0 (population clears the floor, nobody
    // receives) is still 0.
    receivingWomenPct: women.length >= threshold ? pct(womenRecipients.length, women.length) : null,
    receivingMenPct: men.length >= threshold ? pct(menRecipients.length, men.length) : null
  };

  // (b)/(d). Both sides' RECIPIENT counts must clear the floor: the gap is
  // computed over recipients, so that is the population being disclosed.
  if (womenRecipients.length < threshold || menRecipients.length < threshold) {
    out.redacted = true;
    return out;
  }
  out.redacted = false;
  const meanPct = ratioPct(mean(womenRecipients), mean(menRecipients));
  const medPct = ratioPct(median(womenRecipients), median(menRecipients));
  out.meanWomensPctOfMen = meanPct;
  out.medianWomensPctOfMen = medPct;
  out.meanGapPp = meanPct === null ? null : Math.round((100 - meanPct) * 10) / 10;
  out.medianGapPp = medPct === null ? null : Math.round((100 - medPct) * 10) / 10;
  return out;
}

// ── Hourly pay, prepared (#2329, owner decision D4 2026-09-28) ───────────────
// Directive art. 3 defines pay level as gross annual AND gross hourly pay; the
// Swedish transposition has not settled which basis each art. 9 item uses. The
// owner's decision is "prepare now": compute an hourly figure where it can be
// derived, shown as a SECONDARY, "preparation" figure next to the annual ones,
// never replacing them.
//
// DERIVATION (the documented assumption):
//   annual pay      = (BASE SALARY + VARIABLE PAY + ALLOWANCES) × 12 — the stored monthly
//                     figures, NOT full-time normalised (hours do that part);
//   contracted hours = FULL-TIME EQ. × fullTimeWeeklyHours × 52;
//   hourly          = annual pay ÷ contracted hours.
// fullTimeWeeklyHours is the org setting `fullTimeWeeklyHours` (settings/
// global) when valid, else 40 (the Swedish statutory full-time week and the
// constant salaryHistory.js / scheduleCalc.js already use). With one full-time
// week for everyone the hourly GAP equals the FTE gap; it starts to differ
// once full-time hours vary per legal entity. #2577: a legal entity's own
// fullTimeWeeklyHours wins over the org default for its employees (see
// resolveEmployeeFullTimeWeeklyHours). There is no collective-agreement data
// model yet, so a per-agreement week is set on the entity it applies to.
//
// COVERAGE. Hours are "known" only when FULL-TIME EQ. is a valid stored value
// (normalizeFteValue). The analysis's employee-favouring fallback to 1.0 is
// deliberately NOT used here: a guessed 1.0 would invent contracted hours, so
// an employee without a usable FULL-TIME EQ. is EXCLUDED and counted in
// excludedCount — the report states "covered N of M".
//
// ANONYMITY is the gendered-median rule (redactClassificationRow): the figures
// are per-gender pay statistics, so BOTH genders' covered counts must clear
// the floor, or nothing but the coverage counts is disclosed.
//
// #2639 P2 — ACTUAL hourly pay. An employee's own contracted hours per week
// (the optional employee field "CONTRACTED HOURS", "Avtalade timmar per
// vecka", 0 < h <= 60) win: contracted hours = CONTRACTED HOURS × 52. Without
// it the FTE derivation above applies (FULL-TIME EQ. × the legal entity's /
// org's full-time week × 52). Neither -> not covered, as before.
// STATUS: the block is no longer a "preparation" figure once at least
// HOURLY_REPORTED_COVERAGE_PCT (90 %) of the eligible employees are covered
// by one of the two sources -> status "reported". Below that it stays
// "preparation": with more than a tenth of the workforce missing, the hourly
// gap is not representative enough to stand next to the annual figures as a
// reported indicator. The threshold and the coverage are recorded on the
// block (reportedCoverageThresholdPct, coveragePct) so an archived copy says
// which rule labelled it. The anonymity guards are unchanged.
const HOURLY_REPORTED_COVERAGE_PCT = 90;
const CONTRACTED_HOURS_FIELD = "CONTRACTED HOURS";
const HOURLY_DEFAULT_FULL_TIME_WEEKLY_HOURS = 40;
const HOURLY_WEEKS_PER_YEAR = 52;
const HOURLY_MAX_FULL_TIME_WEEKLY_HOURS = 60;

function resolveFullTimeWeeklyHours(settings) {
  const raw = settings && settings.fullTimeWeeklyHours;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw == null ? "" : raw).replace(",", "."));
  return (Number.isFinite(n) && n > 0 && n <= HOURLY_MAX_FULL_TIME_WEEKLY_HOURS) ? n : HOURLY_DEFAULT_FULL_TIME_WEEKLY_HOURS;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// #2577 — the ONE validator for a stored full-time week (a legal entity's
// fullTimeWeeklyHours, the org default settings.fullTimeWeeklyHours). Accepts
// a number or a "37,5"-style string with 0 < h <= 60, rounded to 2 decimals;
// null/undefined/"" means "not set" (value null — inherit). Anything else is
// { ok:false } and the write path rejects it (invalid-argument).
function normalizeFullTimeWeeklyHoursInput(raw) {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { ok: true, value: null };
  let n = NaN;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^\s*\d+([.,]\d+)?\s*$/.test(raw)) n = parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(n)) return { ok: false };
  // Bug hunt P3 — range-check the ROUNDED value (the one that is stored):
  // "0,004" used to pass "> 0" and then be stored as 0.
  const v = round2(n);
  if (v <= 0 || v > HOURLY_MAX_FULL_TIME_WEEKLY_HOURS) return { ok: false };
  return { ok: true, value: v };
}

// #2577 — an employee's full-time week: their legal entity's own value
// (employee.legalEntityId -> byEntity[id]) when valid, else the org default
// (itself resolved to 40 when unset/invalid). Pure.
function resolveEmployeeFullTimeWeeklyHours(e, byEntity, orgDefault) {
  const fallback = resolveFullTimeWeeklyHours({ fullTimeWeeklyHours: orgDefault });
  const id = e && e.legalEntityId != null ? String(e.legalEntityId) : "";
  if (!id || !byEntity || typeof byEntity !== "object" || !Object.prototype.hasOwnProperty.call(byEntity, id)) return fallback;
  const r = normalizeFullTimeWeeklyHoursInput(byEntity[id]);
  return (r.ok && r.value !== null) ? r.value : fallback;
}

function buildHourlyPayMetrics(employees, opts) {
  const o = opts || {};
  const threshold = resolveMinTeamSize(o);
  const weekly = resolveFullTimeWeeklyHours({ fullTimeWeeklyHours: o.fullTimeWeeklyHours });
  // #2577 — per legal entity ({ [entityId]: hours }); absent -> everyone on
  // the org week, exactly as before.
  const byEntity = o.fullTimeWeeklyHoursByEntity || null;
  let minWeek = Infinity;
  let maxWeek = -Infinity;
  const pool = eligible(employees);
  const women = [];
  const men = [];
  let covered = 0;
  let contractedCount = 0;
  const excludedByGender = { female: 0, male: 0 };
  pool.forEach((e) => {
    // #2639 P2 — the person's own contracted hours first.
    const own = normalizeFullTimeWeeklyHoursInput(e[CONTRACTED_HOURS_FIELD]);
    const ownHours = own.ok && own.value !== null ? own.value : null;
    const fte = normalizeFteValue(e["FULL-TIME EQ."]);
    if (ownHours === null && !fte.valid) {
      const b = genderBucket(e.GENDER);
      if (b === "female" || b === "male") excludedByGender[b] += 1;
      return;
    }
    covered += 1;
    const base = num(e["BASE SALARY"]);
    const annual = (base + complementaryRaw(e)) * 12; // #4 — incl. allowances
    let weeklyContracted;
    if (ownHours !== null) {
      contractedCount += 1;
      weeklyContracted = ownHours;
    } else {
      const week = byEntity ? resolveEmployeeFullTimeWeeklyHours(e, byEntity, weekly) : weekly;
      if (week < minWeek) minWeek = week;
      if (week > maxWeek) maxWeek = week;
      weeklyContracted = fte.value * week;
    }
    const hourly = annual / (weeklyContracted * HOURLY_WEEKS_PER_YEAR);
    const bucket = genderBucket(e.GENDER);
    if (bucket === "female") women.push(hourly);
    else if (bucket === "male") men.push(hourly);
  });
  const coveragePct = pool.length ? Math.round((covered / pool.length) * 1000) / 10 : 0;
  const out = {
    // Bug hunt eu-p2 — the label uses the EXACT share, not the 1-decimal
    // display value: 188/209 = 89.95 % rounds to 90.0 but is below the rule.
    status: (pool.length > 0 && covered * 100 >= HOURLY_REPORTED_COVERAGE_PCT * pool.length) ? "reported" : "preparation",
    basis: "annual_pay_over_contracted_hours",
    fullTimeWeeklyHours: weekly,
    weeksPerYear: HOURLY_WEEKS_PER_YEAR,
    thresholdUsed: threshold,
    eligibleCount: pool.length,
    coveredCount: covered,
    excludedCount: pool.length - covered,
    // #2639 P2 — where the hours came from, and the labelling rule.
    contractedHoursCount: contractedCount,
    fteDerivedCount: covered - contractedCount,
    coveragePct,
    reportedCoverageThresholdPct: HOURLY_REPORTED_COVERAGE_PCT
  };
  // Differencing guard (bughunt-fixes-2): the monthly figures cover every
  // eligible employee, the hourly ones only those with a known FTE. When 1 to
  // floor-1 people are left out, comparing the two sets singles them out, so
  // the hourly block is withheld exactly as for a too-small gender group.
  // The monthly figures are split by gender, so the guard is applied per
  // gender (bug-hunt P3, fixes-3): 2 excluded women + 1 excluded man at floor
  // 3 must not pass just because the TOTAL reaches the floor.
  const risky = (n) => n > 0 && n < threshold;
  // The overall count stays guarded too (fail closed).
  const differencingRisk = risky(pool.length - covered) || risky(excludedByGender.female) || risky(excludedByGender.male);
  if (women.length < threshold || men.length < threshold || differencingRisk) {
    out.redacted = true;
    return out;
  }
  out.redacted = false;
  // #2577 — the range of full-time weeks actually used, only when it varies
  // (one week for everyone keeps the old shape). Disclosed with the figures
  // only, never on a redacted block.
  if (covered > 0 && minWeek !== Infinity && minWeek !== maxWeek) {
    out.fullTimeWeeklyHoursMixed = true;
    out.fullTimeWeeklyHoursMin = minWeek;
    out.fullTimeWeeklyHoursMax = maxWeek;
  }
  out.womenCount = women.length;
  out.menCount = men.length;
  out.meanHourlyWomen = round2(mean(women));
  out.meanHourlyMen = round2(mean(men));
  out.medianHourlyWomen = round2(median(women));
  out.medianHourlyMen = round2(median(men));
  const meanPct = ratioPct(mean(women), mean(men));
  const medPct = ratioPct(median(women), median(men));
  out.meanGapPp = meanPct === null ? null : Math.round((100 - meanPct) * 10) / 10;
  out.medianGapPp = medPct === null ? null : Math.round((100 - medPct) * 10) / 10;
  return out;
}

// ── Gross annual pay (#2385 Phase 2) ─────────────────────────────────────────
// Directive art. 3 defines pay level as gross annual AND gross hourly pay. The
// hourly block above is annual pay ÷ contracted hours; this is its numerator,
// shown on its own, in the EMPLOYER's currency (payScope.currency — DKK for a
// Danish legal entity's report; one currency per report, #2385 item 2):
//   annual = (BASE SALARY + VARIABLE PAY + ALLOWANCES) × 12, the stored
//            monthly figures — actual gross, NOT full-time normalised.
//          The rows arrive priced by the #2639 P1 component mapping
//          (euPayComponents.applyEuPayComponents: "base" components folded
//          into BASE SALARY, "variable" into VARIABLE PAY, "excluded"
//          dropped), so the annual figure follows the org's mapping as is.
// Population: the same eligible rows as the quartiles (so the per-entity
// differencing rule's "population" measure protects it). Anonymity: the
// gendered rule — both genders must clear the floor, or only the counts of
// the eligible population and the currency are disclosed. Amounts are whole
// currency units.
const ANNUAL_PAY_BASIS = "monthly_pay_x12";
const CURRENCY_RE = /^[A-Z]{3}$/;

function buildAnnualPayMetrics(employees, opts) {
  const o = opts || {};
  const threshold = resolveMinTeamSize(o);
  const currency = typeof o.currency === "string" && CURRENCY_RE.test(o.currency.trim().toUpperCase()) ? o.currency.trim().toUpperCase() : null;
  const pool = eligible(employees);
  const women = [];
  const men = [];
  pool.forEach((e) => {
    const annual = (num(e["BASE SALARY"]) + complementaryRaw(e)) * 12;
    const b = genderBucket(e.GENDER);
    if (b === "female") women.push(annual);
    else if (b === "male") men.push(annual);
  });
  const out = { basis: ANNUAL_PAY_BASIS, currency, thresholdUsed: threshold, eligibleCount: pool.length };
  if (women.length < threshold || men.length < threshold) {
    out.redacted = true;
    return out;
  }
  out.redacted = false;
  out.womenCount = women.length;
  out.menCount = men.length;
  out.meanAnnualWomen = Math.round(mean(women));
  out.meanAnnualMen = Math.round(mean(men));
  out.medianAnnualWomen = Math.round(median(women));
  out.medianAnnualMen = Math.round(median(men));
  const meanPct = ratioPct(mean(women), mean(men));
  const medPct = ratioPct(median(women), median(men));
  out.meanGapPp = meanPct === null ? null : Math.round((100 - meanPct) * 10) / 10;
  out.medianGapPp = medPct === null ? null : Math.round((100 - medPct) * 10) / 10;
  return out;
}

// ── Archive copies (#2350 item 5) ────────────────────────────────────────────
// The annual pay-equity snapshot (payEquitySnapshotFns.js) freezes both
// sections above into a dated Firestore document. These build that frozen
// copy from the builders' output: a fresh plain object (never a reference to
// the live result), with a WHITELIST of fields so the archive can only ever
// hold what the builders disclose.
//
// Redaction is carried, never re-derived: a band is archived with its split
// ONLY when it is explicitly `redacted: false` — anything else (true, missing)
// is archived as redacted with no numbers at all, even if stray figures were
// present on the input (fail closed). Likewise the variable-pay gap figures
// are archived only on an explicit `redacted: false`, and a suppressed (null)
// receiving share stays null — a genuine 0 stays 0 (#2344).
//
// No field is ever `undefined` (Firestore rejects undefined values): a missing
// number on a disclosed row becomes null, which every renderer shows as a dash.
function finiteOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function archivePayQuartiles(q) {
  if (!q || typeof q !== "object") return null;
  const bands = Array.isArray(q.quartiles) ? q.quartiles : [];
  const out = {
    totalIncluded: finiteOrNull(q.totalIncluded),
    thresholdUsed: finiteOrNull(q.thresholdUsed),
    quartiles: bands.map((b, i) => {
      b = b && typeof b === "object" ? b : {};
      const row = {
        quartile: finiteOrNull(b.quartile) !== null ? b.quartile : i + 1,
        total: finiteOrNull(b.total)
      };
      if (b.redacted !== false) {
        row.redacted = true;
        return row;
      }
      row.redacted = false;
      row.women = finiteOrNull(b.women);
      row.men = finiteOrNull(b.men);
      row.other = finiteOrNull(b.other);
      row.womenPct = finiteOrNull(b.womenPct);
      row.menPct = finiteOrNull(b.menPct);
      return row;
    })
  };
  // #2424 — the tie method travels with the frozen bands so an archived year
  // says how its boundary ties were handled. Whitelisted: only a known method
  // is copied; a snapshot made before #2424 simply has none (position slicing).
  if (q.tieMethod === QUARTILE_TIE_METHOD) out.tieMethod = QUARTILE_TIE_METHOD;
  return out;
}

function archiveVariablePayMetrics(v) {
  if (!v || typeof v !== "object") return null;
  const out = {
    anyVariablePay: v.anyVariablePay === true,
    thresholdUsed: finiteOrNull(v.thresholdUsed),
    receivingWomenPct: finiteOrNull(v.receivingWomenPct),
    receivingMenPct: finiteOrNull(v.receivingMenPct)
  };
  if (v.redacted !== false) {
    out.redacted = true;
    return out;
  }
  out.redacted = false;
  out.meanWomensPctOfMen = finiteOrNull(v.meanWomensPctOfMen);
  out.medianWomensPctOfMen = finiteOrNull(v.medianWomensPctOfMen);
  out.meanGapPp = finiteOrNull(v.meanGapPp);
  out.medianGapPp = finiteOrNull(v.medianGapPp);
  return out;
}

// D4 (#2329) — the frozen copy of buildHourlyPayMetrics: same whitelist and
// fail-closed rule as the two above (figures only on an explicit
// redacted:false; coverage counts and the stated assumption always).
function archiveHourlyPayMetrics(h) {
  if (!h || typeof h !== "object") return null;
  const out = {
    // #2639 P2 — carried, never upgraded: only an explicit "reported" stays
    // reported; anything else (an older block, a missing value) archives as
    // the preparation figure it was.
    status: h.status === "reported" ? "reported" : "preparation",
    basis: "annual_pay_over_contracted_hours",
    fullTimeWeeklyHours: finiteOrNull(h.fullTimeWeeklyHours),
    weeksPerYear: finiteOrNull(h.weeksPerYear),
    thresholdUsed: finiteOrNull(h.thresholdUsed),
    eligibleCount: finiteOrNull(h.eligibleCount),
    coveredCount: finiteOrNull(h.coveredCount),
    excludedCount: finiteOrNull(h.excludedCount)
  };
  // #2639 P2 — only on a block that has them, so an older archive keeps its shape.
  ["contractedHoursCount", "fteDerivedCount", "coveragePct", "reportedCoverageThresholdPct"].forEach((k) => {
    if (typeof h[k] === "number" && Number.isFinite(h[k])) out[k] = h[k];
  });
  if (h.redacted !== false) {
    out.redacted = true;
    return out;
  }
  out.redacted = false;
  ["womenCount", "menCount", "meanHourlyWomen", "meanHourlyMen", "medianHourlyWomen", "medianHourlyMen", "meanGapPp", "medianGapPp"]
    .forEach((k) => { out[k] = finiteOrNull(h[k]); });
  // #2577 — only a block that actually had mixed weeks gets the range, so an
  // older (single-week) block archives exactly as before.
  if (h.fullTimeWeeklyHoursMixed === true) {
    out.fullTimeWeeklyHoursMixed = true;
    out.fullTimeWeeklyHoursMin = finiteOrNull(h.fullTimeWeeklyHoursMin);
    out.fullTimeWeeklyHoursMax = finiteOrNull(h.fullTimeWeeklyHoursMax);
  }
  return out;
}

// #2385 — the frozen copy of buildAnnualPayMetrics: whitelist, fail closed
// (figures only on an explicit redacted:false).
function archiveAnnualPayMetrics(a) {
  if (!a || typeof a !== "object") return null;
  const cur = typeof a.currency === "string" && CURRENCY_RE.test(a.currency) ? a.currency : null;
  const out = { basis: ANNUAL_PAY_BASIS, currency: cur, thresholdUsed: finiteOrNull(a.thresholdUsed), eligibleCount: finiteOrNull(a.eligibleCount) };
  if (a.redacted !== false) {
    out.redacted = true;
    return out;
  }
  out.redacted = false;
  ["womenCount", "menCount", "meanAnnualWomen", "meanAnnualMen", "medianAnnualWomen", "medianAnnualMen", "meanGapPp", "medianGapPp"]
    .forEach((k) => { out[k] = finiteOrNull(a[k]); });
  return out;
}

module.exports = {
  EU_PAY_CONCEPT,
  ANNUAL_PAY_BASIS,
  buildAnnualPayMetrics,
  archiveAnnualPayMetrics,
  complementaryPayOf: variableOf,
  HOURLY_DEFAULT_FULL_TIME_WEEKLY_HOURS,
  HOURLY_REPORTED_COVERAGE_PCT, CONTRACTED_HOURS_FIELD,
  HOURLY_WEEKS_PER_YEAR,
  resolveFullTimeWeeklyHours,
  normalizeFullTimeWeeklyHoursInput,
  resolveEmployeeFullTimeWeeklyHours,
  buildHourlyPayMetrics,
  archiveHourlyPayMetrics,
  QUARTILE_COUNT,
  QUARTILE_TIE_METHOD,
  archivePayQuartiles,
  archiveVariablePayMetrics,
  MIN_TEAM_SIZE_FLOOR,
  genderBucket,
  totalPay,
  buildPayQuartiles,
  buildVariablePayMetrics
};
