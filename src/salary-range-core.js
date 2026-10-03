/*
 * public/js/salary-range-core.js — the admin-defined SALARY RANGE REGISTER's
 * pure core ("Lönespann som register"). No DOM, no I/O. Vendored byte-for-byte
 * into functions/vendor-calc/salary-range-core.js (npm run vendor:sync) so the
 * server (salaryRangesFns.js — validation on save) and the browser (the
 * register page, the analysis pages) answer the same questions with the same
 * code.
 *
 * WHAT A RANGE IS. organizations/{orgId}/salaryRanges/{id}:
 *   { name, dimension: { type, value }, appliesTo, currency, min, mid, max,
 *     effectiveFrom, effectiveTo, payPolicyRef, status }
 * - dimension.type: "level" (employee LEVEL), "jobCategory" (jobCategoryId —
 *   a family covers its leaves, path-prefix like policy-scope.js), "equalWorkGroup"
 *   (EQUAL WORK GROUP) or "salaryBand" (SALARY BAND). level / group / band
 *   values compare trimmed and case-insensitively.
 * - appliesTo: the policy scope model (#2485, policy-scope.js) — legal entity,
 *   country, department, office, equal-work group, job category, employment
 *   type, rules. Empty = the whole org.
 * - min / mid / max: whole numbers, MONTHLY FULL-TIME base salary in
 *   `currency` (the same basis the pay-equity analysis compares — BASE SALARY
 *   divided by FULL-TIME EQ., pay-equity-basis.js's fteNormalizedSalary;
 *   variable pay and allowances are NOT part of it). min <= mid <= max.
 * - currency: must be a currency one of the scope's legal entities pays in
 *   (currencyAllowedForScope) — a SEK range cannot be scoped to Denmark.
 *
 * RESOLUTION — unlike pay POLICIES (where every applicable policy is shown,
 * overlap allowed), a range is a RULE: exactly one range applies to a person.
 * resolveSalaryRange keeps the active ranges that are effective on the date,
 * are in the employee's pay currency (never converted), match the dimension
 * and whose scope covers the employee, then picks the MOST SPECIFIC:
 *   1. higher scope score (scopeSpecificity: country 1, legal entity 2,
 *      department / office / job category / equal-work group / employment
 *      type 4 each, each rule 4; the dimensions are AND-ed, so the score adds);
 *   2. smaller scope breadth (how many entities / nodes / values the scope
 *      expands to — a leaf legal entity beats its parent);
 *   3. more specific dimension type: jobCategory > level > salaryBand >
 *      equalWorkGroup (a job is narrower than a grade, a grade narrower than
 *      a value class);
 *   4. smaller dimension breadth (a leaf job category beats its family);
 *   5. later effectiveFrom (the newer rule);
 *   6. id ascending — deterministic; `tiedWith` lists the ranges that were
 *      equal on 1–5 so the register can warn about the overlap.
 * Scope before dimension: a range's scope decides its market (country,
 * employer), which is what makes two ranges comparable at all.
 *
 * POSITION (positionInRange / positionForSalary), on the FTE monthly salary:
 *   compa-ratio  = salary / mid
 *   penetration  = (salary - min) / (max - min)   (null when min === max)
 *   status       = "below" (< min) | "within" | "above" (> max)
 *   belowMinBy / aboveMaxBy = the FTE distance to the limit (0 when inside).
 * A position is personal data (it is derived from a salary); a range is not.
 */
(function () {
  "use strict";

  var isNode = typeof module !== "undefined" && module.exports;
  function lib(nodePath, globalName) {
    if (isNode) return require(nodePath);
    return typeof window !== "undefined" ? window[globalName] : null;
  }
  // Resolved lazily: the browser loads these as separate classic scripts.
  function PolicyScope() { return lib("./policy-scope.js", "PolicyScope"); }
  function PayCurrencyScope() { return lib("./pay-currency-scope.js", "PayCurrencyScope"); }
  function fteNormalizedSalary(e) {
    if (isNode) return require("./pay-equity-basis.js").fteNormalizedSalary(e);
    return typeof window !== "undefined" && typeof window.fteNormalizedSalary === "function" ? window.fteNormalizedSalary(e) : 0;
  }

  var DIMENSION_TYPES = ["level", "jobCategory", "equalWorkGroup", "salaryBand"];
  var DIMENSION_FIELD = { level: "LEVEL", jobCategory: "jobCategoryId", equalWorkGroup: "EQUAL WORK GROUP", salaryBand: "SALARY BAND" };
  var DIMENSION_RANK = { jobCategory: 4, level: 3, salaryBand: 2, equalWorkGroup: 1 };
  var SCOPE_WEIGHTS = { countryCodes: 1, legalEntityIds: 2, orgNodeIds: 4, officeIds: 4, jobCategoryIds: 4, equalWorkGroupIds: 4, employmentTypes: 4 };
  var RULE_WEIGHT = 4;
  var TREE_KEYS = { legalEntityIds: "legalEntities", orgNodeIds: "orgNodes", officeIds: "offices", jobCategoryIds: "jobCategories" };
  var MAX_NAME_LEN = 120;
  var MAX_VALUE_LEN = 200;
  var MAX_AMOUNT = 100000000;
  var POLICY_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
  var CURRENCY_RE = /^[A-Z]{3}$/;

  function str(v) { return v == null ? "" : String(v).trim(); }
  function lower(v) { return str(v).toLowerCase(); }

  function isIsoDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function toAmount(v) {
    if (typeof v === "string" && v.trim() !== "") v = Number(v.replace(/\s/g, ""));
    if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v || v <= 0 || v > MAX_AMOUNT) return null;
    return v;
  }

  // The currencies the scope's legal entities pay in. An entity without its
  // own currency pays in the org default; an org with no entities pays in
  // the org default only.
  function currenciesForScope(appliesTo, ctx) {
    ctx = ctx || {};
    var scopeCtx = ctx.scope || {};
    var pay = ctx.pay || {};
    var def = str(pay.defaultCurrency).toUpperCase() || "SEK";
    var entities = pay.entities || {};
    var ids = Object.keys(entities);
    if (!ids.length) return [def];
    var PS = PolicyScope();
    var a = PS ? PS.normalizeAppliesTo(appliesTo) : null;
    var keep = ids;
    if (a && a.legalEntityIds.length) {
      var expanded = PS.expandSubtree(scopeCtx.legalEntities, a.legalEntityIds);
      keep = keep.filter(function (id) { return expanded.indexOf(id) !== -1; });
    }
    if (a && a.countryCodes.length) {
      keep = keep.filter(function (id) { return a.countryCodes.indexOf(str(entities[id] && entities[id].countryCode).toUpperCase()) !== -1; });
    }
    var out = [];
    keep.forEach(function (id) {
      var c = str(entities[id] && entities[id].currency).toUpperCase() || def;
      if (out.indexOf(c) === -1) out.push(c);
    });
    // Unscoped by employer (no entity / country dimension): an employee may
    // still be paid in the org default without an entity.
    if (!(a && (a.legalEntityIds.length || a.countryCodes.length)) && out.indexOf(def) === -1) out.push(def);
    return out.sort();
  }

  function currencyAllowedForScope(currency, appliesTo, ctx) {
    return currenciesForScope(appliesTo, ctx).indexOf(str(currency).toUpperCase()) !== -1;
  }

  // validateSalaryRangeInput(raw, ctx) -> { value, errors: [code] }.
  // `value` is the normalised range (only meaningful when errors is empty).
  function validateSalaryRangeInput(raw, ctx) {
    var r = raw && typeof raw === "object" ? raw : {};
    var errors = [];
    var name = str(r.name).slice(0, MAX_NAME_LEN);
    if (!name) errors.push("name_required");
    var dim = r.dimension && typeof r.dimension === "object" ? r.dimension : {};
    var type = str(dim.type);
    if (DIMENSION_TYPES.indexOf(type) === -1) errors.push("dimension_type_invalid");
    var dimValue = str(dim.value).slice(0, MAX_VALUE_LEN);
    if (!dimValue) errors.push("dimension_value_required");
    var PS = PolicyScope();
    var appliesTo = PS ? PS.normalizeAppliesTo(r.appliesTo) : null;
    var currency = str(r.currency).toUpperCase();
    if (!CURRENCY_RE.test(currency)) errors.push("currency_invalid");
    else if (!currencyAllowedForScope(currency, appliesTo, ctx)) errors.push("currency_not_in_scope");
    var min = toAmount(r.min);
    var mid = toAmount(r.mid);
    var max = toAmount(r.max);
    if (min === null) errors.push("min_invalid");
    if (mid === null) errors.push("mid_invalid");
    if (max === null) errors.push("max_invalid");
    if (min !== null && mid !== null && min > mid) errors.push("min_gt_mid");
    if (mid !== null && max !== null && mid > max) errors.push("mid_gt_max");
    if (min !== null && max !== null && mid === null && min > max) errors.push("min_gt_max");
    var effectiveFrom = str(r.effectiveFrom);
    if (!isIsoDate(effectiveFrom)) errors.push("effective_from_invalid");
    var effectiveTo = str(r.effectiveTo) || null;
    if (effectiveTo !== null) {
      if (!isIsoDate(effectiveTo)) errors.push("effective_to_invalid");
      else if (isIsoDate(effectiveFrom) && effectiveTo < effectiveFrom) errors.push("effective_to_before_from");
    }
    var payPolicyRef = null;
    if (r.payPolicyRef != null && r.payPolicyRef !== "") {
      var ref = r.payPolicyRef;
      var pid = str(ref && ref.policyId);
      var seq = Number(ref && ref.versionSeq);
      if (!POLICY_ID_RE.test(pid) || !Number.isSafeInteger(seq) || seq < 1) errors.push("pay_policy_ref_invalid");
      else payPolicyRef = { policyId: pid, versionSeq: seq };
    }
    return {
      errors: errors,
      value: {
        name: name,
        dimension: { type: type, value: dimValue },
        appliesTo: appliesTo,
        currency: currency,
        min: min, mid: mid, max: max,
        effectiveFrom: effectiveFrom,
        effectiveTo: effectiveTo,
        payPolicyRef: payPolicyRef
      }
    };
  }

  function isActive(range) {
    return !!range && (range.status == null || range.status === "active");
  }

  function isEffectiveOn(range, date) {
    if (!range || !isIsoDate(date)) return false;
    var from = str(range.effectiveFrom);
    if (!from || date < from) return false;
    var to = str(range.effectiveTo);
    return !to || date <= to;
  }

  // The job-category subtree a jobCategory dimension covers.
  function dimensionIds(range, scopeCtx) {
    var d = range.dimension || {};
    if (d.type !== "jobCategory") return null;
    var PS = PolicyScope();
    return PS ? PS.expandSubtree((scopeCtx || {}).jobCategories, [str(d.value)]) : [str(d.value)];
  }

  function matchesDimension(employee, range, scopeCtx) {
    var d = range && range.dimension;
    if (!d || !DIMENSION_FIELD[d.type]) return false;
    var raw = employee ? employee[DIMENSION_FIELD[d.type]] : "";
    if (d.type === "jobCategory") {
      var id = str(raw);
      return !!id && dimensionIds(range, scopeCtx).indexOf(id) !== -1;
    }
    var v = lower(raw);
    return !!v && v === lower(d.value);
  }

  // { score, breadth } — see the header's resolution order.
  function scopeSpecificity(appliesTo, scopeCtx) {
    var PS = PolicyScope();
    var a = PS ? PS.normalizeAppliesTo(appliesTo) : null;
    if (!a) return { score: 0, breadth: Infinity };
    var score = 0;
    var breadth = 0;
    Object.keys(SCOPE_WEIGHTS).forEach(function (k) {
      if (!a[k] || !a[k].length) return;
      score += SCOPE_WEIGHTS[k];
      breadth += TREE_KEYS[k] ? PS.expandSubtree((scopeCtx || {})[TREE_KEYS[k]], a[k]).length : a[k].length;
    });
    score += a.rules.length * RULE_WEIGHT;
    return { score: score, breadth: breadth };
  }

  function rankOf(range, scopeCtx) {
    var s = scopeSpecificity(range.appliesTo, scopeCtx);
    var dims = dimensionIds(range, scopeCtx);
    return {
      score: s.score,
      breadth: s.breadth,
      dimRank: DIMENSION_RANK[(range.dimension || {}).type] || 0,
      dimBreadth: dims ? dims.length : 1,
      from: str(range.effectiveFrom)
    };
  }

  // Negative when a is MORE specific than b (sorts first). Ignores id.
  function compareRank(a, b) {
    if (a.score !== b.score) return b.score - a.score;
    if (a.breadth !== b.breadth) return a.breadth < b.breadth ? -1 : 1;
    if (a.dimRank !== b.dimRank) return b.dimRank - a.dimRank;
    if (a.dimBreadth !== b.dimBreadth) return a.dimBreadth - b.dimBreadth;
    if (a.from !== b.from) return a.from > b.from ? -1 : 1;
    return 0;
  }

  // Every range that COULD apply to the employee on `date` (before the
  // most-specific pick). ctx = { scope: policy-scope ctx, pay: payContext }.
  function candidateRanges(employee, ranges, date, ctx) {
    if (!employee || !Array.isArray(ranges)) return [];
    ctx = ctx || {};
    var PS = PolicyScope();
    var PCS = PayCurrencyScope();
    var currency = PCS ? PCS.resolveEmployeePayCurrency(employee, ctx.pay || null) : str(employee.CURRENCY).toUpperCase();
    return ranges.filter(function (r) {
      return isActive(r) && isEffectiveOn(r, date) &&
        str(r.currency).toUpperCase() === currency &&
        matchesDimension(employee, r, ctx.scope) &&
        (!PS || PS.employeeMatchesAppliesTo(employee, r.appliesTo, ctx.scope || {}));
    });
  }

  // -> null | { range, candidates, tiedWith: [id] }
  function resolveSalaryRange(employee, ranges, date, ctx) {
    ctx = ctx || {};
    var cands = candidateRanges(employee, ranges, date, ctx);
    if (!cands.length) return null;
    var ranked = cands.map(function (r) { return { r: r, k: rankOf(r, ctx.scope) }; });
    ranked.sort(function (x, y) {
      var c = compareRank(x.k, y.k);
      if (c) return c;
      return str(x.r.id) < str(y.r.id) ? -1 : (str(x.r.id) > str(y.r.id) ? 1 : 0);
    });
    var best = ranked[0];
    var tied = ranked.slice(1).filter(function (x) { return compareRank(best.k, x.k) === 0; }).map(function (x) { return str(x.r.id); });
    return { range: best.r, candidates: cands.length, tiedWith: tied };
  }

  function positionForSalary(salary, range) {
    var s = Number(salary);
    if (!range || !isFinite(s) || s <= 0) return null;
    var min = Number(range.min), mid = Number(range.mid), max = Number(range.max);
    if (!(min > 0) || !(mid > 0) || !(max > 0)) return null;
    var status = s < min ? "below" : (s > max ? "above" : "within");
    return {
      salary: s,
      compaRatio: s / mid,
      penetration: max > min ? (s - min) / (max - min) : null,
      status: status,
      belowMinBy: s < min ? min - s : 0,
      aboveMaxBy: s > max ? s - max : 0
    };
  }

  function positionInRange(employee, range) {
    var s = fteNormalizedSalary(employee);
    return s > 0 ? positionForSalary(s, range) : null;
  }

  var api = {
    DIMENSION_TYPES: DIMENSION_TYPES,
    DIMENSION_FIELD: DIMENSION_FIELD,
    isIsoDate: isIsoDate,
    currenciesForScope: currenciesForScope,
    currencyAllowedForScope: currencyAllowedForScope,
    validateSalaryRangeInput: validateSalaryRangeInput,
    isActive: isActive,
    isEffectiveOn: isEffectiveOn,
    matchesDimension: matchesDimension,
    scopeSpecificity: scopeSpecificity,
    candidateRanges: candidateRanges,
    resolveSalaryRange: resolveSalaryRange,
    positionForSalary: positionForSalary,
    positionInRange: positionInRange
  };
  if (typeof window !== "undefined") window.SalaryRangeCore = api;
  if (isNode) module.exports = api;
})();
