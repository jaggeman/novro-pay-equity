"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Novro = require("../src");

function person(gender, salary, extra) {
  return Object.assign({
    GENDER: gender,
    ROLE: "Engineer",
    LEVEL: "Senior",
    "EQUAL WORK GROUP": "Engineering",
    "BASE SALARY": salary,
    "FULL-TIME EQ.": 1,
    CURRENCY: "SEK"
  }, extra || {});
}

test("exports the supported calculation areas", () => {
  for (const key of ["analyzePayEquity", "salaryRevision", "correctionPlans", "revisionBudget", "salaryRanges", "euReporting"]) {
    assert.ok(Novro[key], `missing export: ${key}`);
  }
});

test("normalises FTE and fixed allowances on the selected analysis basis", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => person("Female", 20000, { "FULL-TIME EQ.": 0.5, ALLOWANCES: 2000 })),
    ...Array.from({ length: 3 }, () => person("Male", 44000, { ALLOWANCES: 0 }))
  ];
  const result = Novro.analyzePayEquity(rows, { minTeamSize: 3, payBasis: "baseSalaryAndAllowances" });
  assert.equal(result.averageSalaryWomen, 44000);
  assert.equal(result.averageSalaryMen, 44000);
  assert.equal(result.womensPayPercentage, 100);
});

test("redacts a gender pay result below the anonymity threshold", () => {
  const rows = [person("Female", 40000), ...Array.from({ length: 3 }, () => person("Male", 45000))];
  const result = Novro.analyzePayEquity(rows, { minTeamSize: 3 });
  assert.equal(result.womensPayPercentage, "N/A");
  assert.equal(result.womenPayRedacted, true);
  assert.equal(result.anonymityThreshold, 3);
});

test("applies flat salary-review rules pro rata by FTE", () => {
  assert.equal(Novro.salaryRevision.applyRuleToSalary(30000, 0.5, { valueType: "flat", value: 1000 }), 30500);
});

test("simulates a percentage review without mutating input", () => {
  const rows = [person("Female", 40000), person("Male", 50000)];
  const result = Novro.salaryRevision.computeRevisionSimulation(rows, [{ valueType: "percentage", value: 3, scope: "All", gender: "All" }]);
  assert.equal(rows[0]["BASE SALARY"], 40000);
  assert.equal(result.affectedCount, 2);
  assert.equal(result.simulatedEmployees[0]["BASE SALARY"], 41200);
});

test("phases a correction plan over its configured years", () => {
  const result = Novro.correctionPlans.revisionShareForYear({
    years: 1,
    yearlySplitPct: [100],
    targetSalary: 50000,
    monthlyGap: 6000
  }, { currentSalary: 44000, startYear: 2026, cycleYear: 2026 });
  assert.equal(result.suggestedSalary, 50000);
  assert.equal(result.suggestedRaise, 6000);
});

test("keeps salary-review budgets separated by currency", () => {
  const result = Novro.revisionBudget.budgetByCurrency({
    rows: [
      { currency: "SEK", salary: 100 },
      { currency: "SEK", salary: 200 },
      { currency: "DKK", salary: 1000 }
    ],
    budgetType: "percent",
    budgetValue: 10,
    preferredCurrency: "SEK"
  });
  assert.deepEqual(result.currencies, ["SEK", "DKK"]);
  assert.equal(result.byCurrency.SEK.budget, 30);
  assert.equal(result.byCurrency.DKK.budget, 100);
});

test("uses FTE-normalised pay for salary-range position", () => {
  const result = Novro.salaryRanges.positionInRange(person("Female", 36000, { "FULL-TIME EQ.": 0.8 }), {
    min: 40000, mid: 50000, max: 60000
  });
  assert.equal(result.salary, 45000);
  assert.equal(result.compaRatio, 0.9);
  assert.equal(result.status, "within");
});

test("validates and resolves salary ranges from the installed core", () => {
  const range = {
    id: "senior-se",
    name: "Senior engineer",
    dimension: { type: "level", value: "Senior" },
    appliesTo: {},
    currency: "SEK",
    min: 40000,
    mid: 50000,
    max: 60000,
    effectiveFrom: "2026-01-01",
    status: "active"
  };
  const context = {
    scope: {},
    pay: { defaultCurrency: "SEK", entities: {} }
  };

  const validation = Novro.salaryRanges.validateSalaryRangeInput(range, context);
  assert.deepEqual(validation.errors, []);

  const resolved = Novro.salaryRanges.resolveSalaryRange(
    person("Female", 45000, { LEVEL: "Senior" }),
    [range],
    "2026-10-03",
    context
  );
  assert.equal(resolved.range.id, "senior-se");
});

test("builds four EU pay quartiles from eligible employees", () => {
  const rows = Array.from({ length: 12 }, (_, i) => person(i % 2 ? "Male" : "Female", 30000 + i * 1000));
  const result = Novro.euReporting.buildPayQuartiles(rows, { minTeamSize: 3 });
  assert.equal(result.totalIncluded, 12);
  assert.deepEqual(result.quartiles.map((q) => q.total), [3, 3, 3, 3]);
});

test("calculates and anonymity-gates EU variable-pay metrics", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => person("Female", 40000, { "VARIABLE PAY": 1000 })),
    ...Array.from({ length: 3 }, () => person("Male", 40000, { "VARIABLE PAY": 2000 }))
  ];
  const result = Novro.euReporting.buildVariablePayMetrics(rows, { minTeamSize: 3 });
  assert.equal(result.redacted, false);
  assert.equal(result.meanGapPp, 50);
  assert.equal(result.receivingWomenPct, 100);
  assert.equal(result.receivingMenPct, 100);
});

test("ships parseable JSON schemas", () => {
  const schemaDir = path.join(__dirname, "..", "schemas");
  for (const name of fs.readdirSync(schemaDir).filter((file) => file.endsWith(".json"))) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, name), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.ok(schema.title);
  }
});
