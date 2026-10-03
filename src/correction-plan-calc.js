/**
 * public/js/correction-plan-calc.js — the pay-equity correction plan's rules
 * (Lönekartläggning ▸ Åtgärdsplan), in ONE pure place so the browser page
 * (public/js/action-plan.js), the server validator
 * (functions/payEquityJustifications.js) and the annual snapshot
 * (functions/payEquitySnapshot.js) can never disagree.
 *
 * What it owns:
 *   - the allowed plan lengths: 1–5 years (was 1–3);
 *   - the default yearly split for each length (34/33/33, 25×4, 20×5 …);
 *   - the "does the split add up to 100 %" rule (±0.5 for rounding);
 *   - the yearly cost of a plan, as TWO figures per year (#2350 item 4,
 *     owner decision): the NEW raise that year (its own split share) and the
 *     CUMULATIVE salary cost including every earlier raise. A 34/33/33 plan
 *     on a 120 000/yr gap costs new 40 800 / 39 600 / 39 600 and cumulative
 *     40 800 / 80 400 / 120 000; a finished plan keeps costing its full
 *     annual amount in the years after it (the raise persists) with no new
 *     raise;
 *   - the summary of a whole set of plans (summarizePlans, #2503): totals,
 *     per currency / legal entity, and the timeline — shared by the action
 *     plan page and the documentation plan so their numbers never differ;
 *   - the Swedish statutory-limit rule. Diskrimineringslagen (2008:567)
 *     3 kap. 13 § första stycket 5 (Lag 2016:828, current wording) says the
 *     documentation's cost and time plan shall be based on "målsättningen att
 *     de lönejusteringar som behöver vidtas ska genomföras så snart som
 *     möjligt och senast inom tre år". A 4- or 5-year plan is allowed (EU
 *     directive 2023/970 art. 10(4) only says "within a reasonable period of
 *     time"; other countries have no fixed cap), but for a Swedish employee
 *     it needs a recorded reason and is shown with a warning. An unknown
 *     country is treated as Swedish — the app's default everywhere else
 *     (pay-currency-scope.js), and the safe side of the rule.
 *
 * PURE and DUAL-MODE (module.exports + window.CorrectionPlanCalc), VENDORED
 * into functions/vendor-calc/ for deploy packaging (sync-calc-vendor.js) —
 * this is the canonical source.
 */
(function () {
  "use strict";

  var MIN_YEARS = 1;
  var MAX_YEARS = 5;
  var YEARS = [1, 2, 3, 4, 5];
  // Diskrimineringslagen 3 kap. 13 § p. 5 — "senast inom tre år".
  var SE_STATUTORY_MAX_YEARS = 3;
  // How many years the cost figures cover (the longest allowed plan).
  var COST_HORIZON = MAX_YEARS;
  var DEFAULT_YEARS = 3;
  // Splits are typed as whole percentages (34/33/33); allow float rounding.
  var SPLIT_SUM_DRIFT = 0.5;
  var MAX_EXTENDED_REASON_LEN = 500;
  var MIN_EXTENDED_REASON_LEN = 3;

  function normalizeYears(v) {
    var n = Number(v);
    return YEARS.indexOf(n) >= 0 ? n : null;
  }

  // An even split with the remainder on the first years, so it always sums
  // to exactly 100: 1 -> [100], 2 -> [50,50], 3 -> [34,33,33],
  // 4 -> [25,25,25,25], 5 -> [20,20,20,20,20].
  function defaultSplits(years) {
    var y = normalizeYears(years) || DEFAULT_YEARS;
    var base = Math.floor(100 / y);
    var rest = 100 - base * y;
    var out = [];
    for (var i = 0; i < y; i++) out.push(base + (i < rest ? 1 : 0));
    return out;
  }

  // Exactly `years` numbers: truncated, padded with 0, non-numbers -> 0.
  function normalizeSplits(splits, years) {
    var y = normalizeYears(years) || DEFAULT_YEARS;
    var src = Array.isArray(splits) ? splits : [];
    var out = [];
    for (var i = 0; i < y; i++) {
      var n = Number(src[i]);
      out.push(Number.isFinite(n) ? n : 0);
    }
    return out;
  }

  function splitTotal(splits) {
    return (Array.isArray(splits) ? splits : []).reduce(function (a, b) {
      var n = Number(b);
      return a + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  // The one validity rule: right length, every share 0..100, sum 100 (±0.5).
  function isValidSplit(splits, years) {
    var y = normalizeYears(years);
    if (!y || !Array.isArray(splits) || splits.length !== y) return false;
    for (var i = 0; i < splits.length; i++) {
      var n = Number(splits[i]);
      if (splits[i] === null || splits[i] === "" || !Number.isFinite(n) || n < 0 || n > 100) return false;
    }
    return Math.abs(splitTotal(splits) - 100) <= SPLIT_SUM_DRIFT;
  }

  // costSchedule(annualGap, splits, horizon?) -> [{ year, newRaise, cumulative }]
  // for years 1..horizon (default 5), or null for an invalid split / gap.
  // newRaise: that year's own share of the annual gap (0 after the plan
  // ends). cumulative: the salary cost that year including every earlier
  // raise (the full annual gap once the plan is finished).
  function costSchedule(annualGap, splits, horizon) {
    var gap = Number(annualGap);
    if (!Number.isFinite(gap) || gap < 0) return null;
    var list = Array.isArray(splits) ? splits : [];
    if (!isValidSplit(list, list.length)) return null;
    var h = Number(horizon) > 0 ? Math.floor(Number(horizon)) : COST_HORIZON;
    var out = [];
    var cumPct = 0;
    for (var i = 0; i < h; i++) {
      var pct = i < list.length ? Number(list[i]) : 0;
      cumPct += pct;
      out.push({
        year: i + 1,
        newRaise: (gap * pct) / 100,
        cumulative: (gap * Math.min(cumPct, 100)) / 100
      });
    }
    return out;
  }

  function isSwedish(countryCode) {
    var cc = typeof countryCode === "string" ? countryCode.trim().toUpperCase() : "";
    return !cc || cc === "SE";
  }

  // True when a plan of `years` needs the Swedish warning + a recorded reason.
  function exceedsSwedishLimit(years, countryCode) {
    var y = normalizeYears(years);
    return !!y && y > SE_STATUTORY_MAX_YEARS && isSwedish(countryCode);
  }

  function cleanExtendedReason(v) {
    return String(v == null ? "" : v).trim().slice(0, MAX_EXTENDED_REASON_LEN);
  }

  function emptySchedule(h) {
    var out = [];
    for (var i = 0; i < h; i++) out.push({ year: i + 1, newRaise: 0, cumulative: 0 });
    return out;
  }
  function addSchedule(into, schedule) {
    for (var i = 0; i < into.length && i < schedule.length; i++) {
      into[i].newRaise += schedule[i].newRaise;
      into[i].cumulative += schedule[i].cumulative;
    }
  }
  function cleanCode(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  // summarizePlans(entries, horizon?) — #2503: the ONE summary of a set of
  // correction plans, used by the action plan page (its KPI tiles) AND the
  // documentation plan / annual snapshot (Kostnadsberäkning + Tidsplan), so
  // the two can never show different numbers.
  //   entry: { annualGap, splits, currency?, legalEntityId?, countryCode?, startYear? }
  // Returns:
  //   employeeCount   — every entry (a plan with an invalid split still counts);
  //   pricedCount     — entries with a valid split + gap (the only ones costed);
  //   totals          — [{ year, newRaise, cumulative }] over ALL priced entries
  //                     (the action plan's single-currency view);
  //   byCurrency      — one group per currency (never summed across currencies):
  //                     { currency, employeeCount, schedule, totalAnnualRaise };
  //   byEntity        — the same per (legal entity, currency), only when the
  //                     entries span more than one legal entity, else [];
  //   startYear/endYear — first start and last end across dated plans (null
  //                     when none), maxYears, exceedsSwedishLimitCount.
  // totalAnnualRaise is the full yearly salary increase once every plan is
  // done (the last cumulative figure).
  function summarizePlans(entries, horizon) {
    var h = Number(horizon) > 0 ? Math.floor(Number(horizon)) : COST_HORIZON;
    var list = Array.isArray(entries) ? entries : [];
    var totals = emptySchedule(h);
    var currencies = {};
    var entities = {};
    var entityIds = {};
    var out = {
      employeeCount: 0, pricedCount: 0, maxYears: 0, totals: totals,
      byCurrency: [], byEntity: [], startYear: null, endYear: null, exceedsSwedishLimitCount: 0
    };
    list.forEach(function (e) {
      if (!e) return;
      out.employeeCount++;
      var splits = Array.isArray(e.splits) ? e.splits : [];
      var years = normalizeYears(splits.length);
      var currency = cleanCode(e.currency).toUpperCase() || "SEK";
      var entityId = cleanCode(e.legalEntityId);
      entityIds[entityId] = true;
      var cKey = currency;
      var eKey = entityId + "|" + currency;
      if (!currencies[cKey]) currencies[cKey] = { currency: currency, employeeCount: 0, schedule: emptySchedule(h), totalAnnualRaise: 0 };
      if (!entities[eKey]) entities[eKey] = { legalEntityId: entityId, currency: currency, employeeCount: 0, schedule: emptySchedule(h), totalAnnualRaise: 0 };
      currencies[cKey].employeeCount++;
      entities[eKey].employeeCount++;
      if (years && exceedsSwedishLimit(years, e.countryCode)) out.exceedsSwedishLimitCount++;
      var schedule = costSchedule(e.annualGap, splits, h);
      if (!schedule) return;
      out.pricedCount++;
      if (years > out.maxYears) out.maxYears = years;
      addSchedule(totals, schedule);
      addSchedule(currencies[cKey].schedule, schedule);
      addSchedule(entities[eKey].schedule, schedule);
      var full = schedule.length ? schedule[schedule.length - 1].cumulative : 0;
      currencies[cKey].totalAnnualRaise += full;
      entities[eKey].totalAnnualRaise += full;
      var start = Number(e.startYear);
      if (Number.isInteger(start) && start > 0) {
        var end = start + years - 1;
        if (out.startYear === null || start < out.startYear) out.startYear = start;
        if (out.endYear === null || end > out.endYear) out.endYear = end;
      }
    });
    var byKey = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
    out.byCurrency = Object.keys(currencies).sort(byKey).map(function (k) { return currencies[k]; });
    if (Object.keys(entityIds).length > 1) {
      out.byEntity = Object.keys(entities).sort(byKey).map(function (k) { return entities[k]; });
    }
    return out;
  }

  // The plan year (1-based) a revision in `cycleYear` falls into, for a plan
  // that started in `startYear`. A cycle before the start counts as year 1; a
  // cycle after the last year returns years + 1 ("the plan should be done").
  // No usable start year -> year 1 (the plan is treated as starting now).
  function planYearFor(startYear, cycleYear, years) {
    var y = normalizeYears(years);
    if (!y) return null;
    var s = Number(startYear);
    var c = Number(cycleYear);
    if (!Number.isInteger(s) || !Number.isInteger(c) || s <= 0 || c <= 0) return 1;
    var idx = c - s + 1;
    if (idx < 1) return 1;
    return idx > y ? y + 1 : idx;
  }

  function round0(n) { return Math.round(Number(n) || 0); }

  // revisionShareForYear(plan, opts) — #2631 (a): what a salary revision in
  // `opts.cycleYear` should give this person according to their correction
  // plan. Monthly figures (like BASE SALARY and the plan's monthlyGap).
  //   plan: { years, yearlySplitPct, targetSalary, monthlyGap? }
  //   opts: { currentSalary, startYear, cycleYear }
  // Returns null for an invalid plan, else:
  //   planYear      — 1..years, or years + 1 once the plan period is over;
  //   planYears     — the plan's length;
  //   yearSharePct  — this year's own split share (0 after the plan);
  //   cumulativePct — the share of the gap that should be closed by the end
  //                   of this year (100 after the plan);
  //   newRaise      — this year's own share of the gap (the per-year view);
  //   floorSalary   — the CUMULATIVE view: the salary the person should have
  //                   at least after this revision (plan base + every share
  //                   up to and including this year), never above the target;
  //   suggestedRaise — max(0, floorSalary - currentSalary). Equals newRaise
  //                   when every earlier year was carried out; larger when an
  //                   earlier year was missed (catch-up); 0 when the salary
  //                   is already at or above the floor;
  //   suggestedSalary — currentSalary + suggestedRaise;
  //   catchUp       — the part of suggestedRaise that makes up for earlier
  //                   years (suggestedRaise - newRaise, never negative).
  // The plan base is targetSalary - monthlyGap (the salary the plan was made
  // on). An old plan without monthlyGap is priced on what is left: the
  // remaining gap (target - current) spread over the remaining shares.
  function revisionShareForYear(plan, opts) {
    var p = plan || {};
    var o = opts || {};
    var splits = Array.isArray(p.yearlySplitPct) ? p.yearlySplitPct.map(Number) : [];
    var years = normalizeYears(p.years) || normalizeYears(splits.length);
    if (!years || !isValidSplit(splits, years)) return null;
    var target = Number(p.targetSalary);
    if (!Number.isFinite(target) || target <= 0) return null;
    var current = Number(o.currentSalary);
    if (!Number.isFinite(current) || current < 0) return null;

    var planYear = planYearFor(o.startYear, o.cycleYear, years);
    var cumPct = 0;
    var prevPct = 0;
    for (var i = 0; i < years && i < planYear; i++) {
      prevPct = cumPct;
      cumPct += splits[i];
    }
    if (planYear > years) prevPct = Math.min(cumPct, 100);
    cumPct = Math.min(cumPct, 100);
    var yearSharePct = planYear > years ? 0 : splits[planYear - 1];

    var gap = Number(p.monthlyGap);
    var floor;
    var newRaise;
    if (Number.isFinite(gap) && gap >= 0) {
      var base = target - gap;
      floor = base + (gap * cumPct) / 100;
      newRaise = (gap * yearSharePct) / 100;
    } else {
      var remaining = Math.max(0, target - current);
      var remainingPct = 100 - Math.min(prevPct, 100);
      if (planYear > years) {
        newRaise = 0;
        floor = target;
      } else {
        var share = remainingPct > 0 ? yearSharePct / remainingPct : 1;
        newRaise = remaining * Math.min(1, share);
        floor = current + newRaise;
      }
    }
    floor = Math.min(target, round0(floor));
    newRaise = round0(newRaise);
    var suggestedRaise = Math.max(0, round0(floor - current));
    return {
      planYear: planYear,
      planYears: years,
      yearSharePct: yearSharePct,
      cumulativePct: cumPct,
      newRaise: newRaise,
      floorSalary: floor,
      suggestedRaise: suggestedRaise,
      suggestedSalary: round0(current) + suggestedRaise,
      catchUp: Math.max(0, suggestedRaise - newRaise)
    };
  }

  var CorrectionPlanCalc = {
    planYearFor: planYearFor,
    revisionShareForYear: revisionShareForYear,
    MIN_YEARS: MIN_YEARS,
    MAX_YEARS: MAX_YEARS,
    YEARS: YEARS,
    DEFAULT_YEARS: DEFAULT_YEARS,
    SE_STATUTORY_MAX_YEARS: SE_STATUTORY_MAX_YEARS,
    COST_HORIZON: COST_HORIZON,
    SPLIT_SUM_DRIFT: SPLIT_SUM_DRIFT,
    MAX_EXTENDED_REASON_LEN: MAX_EXTENDED_REASON_LEN,
    MIN_EXTENDED_REASON_LEN: MIN_EXTENDED_REASON_LEN,
    normalizeYears: normalizeYears,
    defaultSplits: defaultSplits,
    normalizeSplits: normalizeSplits,
    splitTotal: splitTotal,
    isValidSplit: isValidSplit,
    costSchedule: costSchedule,
    summarizePlans: summarizePlans,
    isSwedish: isSwedish,
    exceedsSwedishLimit: exceedsSwedishLimit,
    cleanExtendedReason: cleanExtendedReason
  };

  if (typeof window !== "undefined") window.CorrectionPlanCalc = CorrectionPlanCalc;
  if (typeof module !== "undefined" && module.exports) module.exports = CorrectionPlanCalc;
})();
