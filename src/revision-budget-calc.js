/* ==========================================================================
   Lönerevision budget-estimate calc (QW3 #290) — PURE, dependency-free.

   The CANONICAL home of the revision budget-resolution math shared by the
   server and the browser:
     - the server (functions/revisionBudget.js) re-exports num /
       percentToFlatBudget / resolveGlobalBudget from the VENDORED copy of
       this file (functions/vendor-calc/revision-budget-calc.js — synced by
       `npm run vendor:sync`, drift-guarded by vendor-calc-drift.test.js),
       exactly like salary-revision-calc.js and the other calc cores;
     - the browser loads this file directly (window.RevisionBudgetCalc) so the
       create-cycle form can show a LIVE "≈X% average raise for N employees"
       estimate with the SAME math startRevisionCycleAdmin will apply.

   No DOM, no Firestore — every branch is unit-tested offline
   (functions/test/revision-budget-calc.test.js).
   ========================================================================== */
(function (global) {
  'use strict';

  // Tolerant numeric coercion (mirrors the spirit of core.cleanNumber but pure
  // and local): "30 000 kr" / "30 000 SEK" / "2,5" all coerce sensibly.
  // #630: this strips "kr"/"SEK" as tolerated INPUT noise (an Admin's typed
  // budget figure), not a display format — out of scope for the
  // window.formatCurrency migration (no amount is ever rendered here).
  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const n = parseFloat(String(v).replace(/\s|kr|SEK/gi, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }

  // A flat SEK budget derived from a percentage of the total current salaries.
  // e.g. 3% of 1 000 000 SEK => 30 000 SEK.
  function percentToFlatBudget(totalCurrentSalaries, percent) {
    return num(totalCurrentSalaries) * (num(percent) / 100);
  }

  // Resolve an Admin's global-budget input into a canonical flat SEK figure.
  // budgetType: "flat" (budgetValue is SEK) | "percent" (of totalCurrentSalaries).
  // Returns a non-negative, finite number (negative inputs clamp to 0 — a budget
  // pool is never negative).
  function resolveGlobalBudget(input) {
    const data = input || {};
    let sek;
    if (data.budgetType === 'percent') {
      sek = percentToFlatBudget(data.totalCurrentSalaries, data.budgetValue);
    } else {
      sek = num(data.budgetValue);
    }
    return sek > 0 ? sek : 0;
  }

  // The live create-cycle estimate: given the Admin's budget input and the
  // employees currently SELECTED for the cycle, how big an average raise does
  // that budget buy? Distribution is pro-rata (a uniform %), matching how
  // resolveGlobalBudget sizes a percent budget on the server.
  //   → { headcount, totalCurrentSalaries, budgetSek, avgRaisePct }
  // avgRaisePct is null (not NaN/Infinity) when there are no salaries to
  // spread over — callers render nothing instead of garbage.
  // #2631 (d) — with `data.currencyOf` (employee -> ISO currency code) the
  // estimate is computed PER CURRENCY: the top-level figures are the primary
  // currency's (see pickPrimaryCurrency) and `byCurrency` lists every group.
  // Without it, the old single-group behaviour (every salary in one sum).
  function budgetAdequacyEstimate(input) {
    const data = input || {};
    const employees = Array.isArray(data.employees) ? data.employees : [];
    if (typeof data.currencyOf === 'function') {
      const split = budgetByCurrency({
        budgetType: data.budgetType,
        budgetValue: data.budgetValue,
        preferredCurrency: data.preferredCurrency,
        currencyBudgets: data.currencyBudgets,
        rows: employees.map(function (e) { return { currency: data.currencyOf(e), salary: e && e['BASE SALARY'] }; })
      });
      const primary = split.byCurrency[split.primaryCurrency] || { headcount: 0, totalCurrentSalaries: 0, budget: 0 };
      return {
        headcount: primary.headcount,
        totalCurrentSalaries: primary.totalCurrentSalaries,
        budgetSek: primary.budget,
        avgRaisePct: primary.totalCurrentSalaries > 0 ? (primary.budget / primary.totalCurrentSalaries) * 100 : null,
        currency: split.primaryCurrency,
        mixed: split.mixed,
        byCurrency: split.currencies.map(function (c) {
          const g = split.byCurrency[c];
          return {
            currency: c, headcount: g.headcount, totalCurrentSalaries: g.totalCurrentSalaries, budget: g.budget,
            avgRaisePct: g.totalCurrentSalaries > 0 ? (g.budget / g.totalCurrentSalaries) * 100 : null
          };
        })
      };
    }
    const totalCurrentSalaries = employees.reduce(function (acc, e) {
      return acc + num(e && e['BASE SALARY']);
    }, 0);
    const budgetSek = resolveGlobalBudget({
      budgetType: data.budgetType,
      budgetValue: data.budgetValue,
      totalCurrentSalaries: totalCurrentSalaries
    });
    return {
      headcount: employees.length,
      totalCurrentSalaries: totalCurrentSalaries,
      budgetSek: budgetSek,
      avgRaisePct: totalCurrentSalaries > 0 ? (budgetSek / totalCurrentSalaries) * 100 : null
    };
  }

  function cleanCurrency(c) {
    const s = typeof c === 'string' ? c.trim().toUpperCase() : '';
    return /^[A-Z]{3}$/.test(s) ? s : '';
  }

  // #2631 (d) — which currency a cycle's headline figures (totalCompanyBudget
  // etc.) are in: the preferred one (the cycle's default currency) when anyone
  // is paid in it, else the largest group (a tie resolves alphabetically, so
  // the choice is stable) — the same rule pay-currency-scope.js's
  // buildPayCurrencyScope uses for the salary-mapping aggregates.
  function pickPrimaryCurrency(counts, preferred) {
    const c = counts || {};
    const pref = cleanCurrency(preferred) || 'SEK';
    if (num(c[pref]) > 0) return pref;
    const codes = Object.keys(c).filter(function (k) { return num(c[k]) > 0; }).sort();
    if (!codes.length) return pref;
    return codes.reduce(function (best, k) { return num(c[k]) > num(c[best]) ? k : best; }, codes[0]);
  }

  // budgetByCurrency({ budgetType, budgetValue, rows: [{ currency, salary }],
  //   preferredCurrency?, currencyBudgets? }) — #2631 (d): a revision budget is
  // NEVER a sum of salaries in different currencies. A percent budget is that
  // percentage of each currency group's own salaries. A flat budget is an
  // amount in the primary currency; another currency's budget is taken from
  // currencyBudgets[code] (0 when not given — no budget set for it).
  //   -> { primaryCurrency, mixed, currencies (primary first, then A-Z),
  //        byCurrency: { CODE: { currency, headcount, totalCurrentSalaries, budget } } }
  function budgetByCurrency(input) {
    const data = input || {};
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const byCurrency = {};
    const counts = {};
    const fallback = cleanCurrency(data.preferredCurrency) || 'SEK';
    rows.forEach(function (r) {
      const code = cleanCurrency(r && r.currency) || fallback;
      if (!byCurrency[code]) byCurrency[code] = { currency: code, headcount: 0, totalCurrentSalaries: 0, budget: 0 };
      byCurrency[code].headcount++;
      byCurrency[code].totalCurrentSalaries += num(r && r.salary);
      counts[code] = (counts[code] || 0) + 1;
    });
    const primaryCurrency = pickPrimaryCurrency(counts, fallback);
    const extra = (data.currencyBudgets && typeof data.currencyBudgets === 'object') ? data.currencyBudgets : {};
    Object.keys(byCurrency).forEach(function (code) {
      const g = byCurrency[code];
      if (data.budgetType === 'percent') {
        g.budget = resolveGlobalBudget({ budgetType: 'percent', budgetValue: data.budgetValue, totalCurrentSalaries: g.totalCurrentSalaries });
      } else if (code === primaryCurrency) {
        g.budget = resolveGlobalBudget({ budgetType: 'flat', budgetValue: data.budgetValue });
      } else {
        g.budget = resolveGlobalBudget({ budgetType: 'flat', budgetValue: extra[code] });
      }
    });
    const currencies = Object.keys(byCurrency).sort(function (a, b) {
      if (a === primaryCurrency) return -1;
      if (b === primaryCurrency) return 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return { primaryCurrency: primaryCurrency, mixed: currencies.length > 1, currencies: currencies, byCurrency: byCurrency };
  }

  // Computes the Compa-Ratio of a salary against a salary band midpoint (0..N %).
  // Returns null if midpoint is invalid/non-positive or salary is invalid.
  function computeCompaRatio(salary, bandMidpoint) {
    const s = num(salary);
    const mid = num(bandMidpoint);
    if (mid <= 0 || s <= 0) return null;
    return Math.round((s / mid) * 100);
  }

  // Matches an employee record against a list of salary band definitions from settings.
  // Matching checks ROLE, LEVEL, or SALARY BAND title.
  function resolveEmployeeSalaryBand(employee, salaryBands) {
    if (!employee || !Array.isArray(salaryBands) || salaryBands.length === 0) return null;
    const empRole = String(employee.ROLE || '').toLowerCase().trim();
    const empLevel = String(employee.LEVEL || '').toLowerCase().trim();
    const empBand = String(employee['SALARY BAND'] || '').toLowerCase().trim();

    const match = salaryBands.find(function (b) {
      if (!b) return false;
      const bName = String(b.name || b.title || '').toLowerCase().trim();
      const bRole = String(b.role || '').toLowerCase().trim();
      const bLevel = String(b.level || '').toLowerCase().trim();

      if (empBand && bName && empBand === bName) return true;
      if (empRole && bRole && empRole === bRole) {
        if (!bLevel || (empLevel && empLevel === bLevel)) return true;
      }
      return false;
    });

    if (!match) return null;
    return {
      id: match.id || match.name,
      name: match.name || match.title || '',
      min: num(match.min),
      mid: num(match.mid),
      max: num(match.max)
    };
  }

  // Step 5 ("Budget per enhet") redesign — weighted-average of every org
  // unit's OWN budget % right now, weighted by that unit's own current-salary
  // total (the exact same weighting collectCreateCycleFormState already uses
  // to resolve each row's SEK figure). nodeInputs: array of { percent,
  // salaryTotal }. Returns null (never NaN) when there's no salary to weight
  // against — callers render nothing instead of garbage.
  function weightedAverageNodePercent(nodeInputs) {
    const list = Array.isArray(nodeInputs) ? nodeInputs : [];
    let weightedSum = 0;
    let totalWeight = 0;
    list.forEach(function (n) {
      const weight = num(n && n.salaryTotal);
      if (weight <= 0) return;
      weightedSum += num(n && n.percent) * weight;
      totalWeight += weight;
    });
    return totalWeight > 0 ? weightedSum / totalWeight : null;
  }

  // The full step-5 summary line: the weighted average above PLUS its delta
  // (in percentage points) against the step-1 base %. Null when the weighted
  // average itself is null (nothing to show).
  function nodeBudgetWeightedSummary(nodeInputs, basePercent) {
    const avg = weightedAverageNodePercent(nodeInputs);
    if (avg === null) return null;
    return {
      weightedAveragePercent: avg,
      deltaPercentagePoints: avg - num(basePercent)
    };
  }

  const api = {
    num: num,
    percentToFlatBudget: percentToFlatBudget,
    resolveGlobalBudget: resolveGlobalBudget,
    budgetAdequacyEstimate: budgetAdequacyEstimate,
    pickPrimaryCurrency: pickPrimaryCurrency,
    budgetByCurrency: budgetByCurrency,
    computeCompaRatio: computeCompaRatio,
    resolveEmployeeSalaryBand: resolveEmployeeSalaryBand,
    weightedAverageNodePercent: weightedAverageNodePercent,
    nodeBudgetWeightedSummary: nodeBudgetWeightedSummary
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api; // Node (vendored copy in functions/vendor-calc)
  } else if (global) {
    global.RevisionBudgetCalc = api; // browser
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
