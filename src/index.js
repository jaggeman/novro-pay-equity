"use strict";

const payEquityBasis = require("./pay-equity-basis.js");
const { createCalculator } = require("./calculator.js");
const salaryRevision = require("./salary-revision-calc.js");
const correctionPlans = require("./correction-plan-calc.js");
const revisionBudget = require("./revision-budget-calc.js");
const salaryRanges = require("./salary-range-core.js");
const euReporting = require("./eu-pay-reporting-metrics.js");

/**
 * High-level pay-equity overview on one explicit pay basis.
 * Disclosure is anonymity-gated by default. Pass { redact: false } only in a
 * trusted environment that is authorised to reveal small-group pay figures.
 */
function analyzePayEquity(employees, settings, options) {
  const opts = options || {};
  const rows = payEquityBasis.withAnalysisPayBasis(employees || [], {
    settings: settings || {},
    includeVariablePay: opts.includeVariablePay === true
  });
  return createCalculator(rows, settings || {}, { redact: opts.redact });
}

module.exports = {
  analyzePayEquity,
  createCalculator,
  payEquityBasis,
  salaryRevision,
  correctionPlans,
  revisionBudget,
  salaryRanges,
  euReporting
};
