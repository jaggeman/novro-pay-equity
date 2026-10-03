# Novro Pay Equity Core

An open-source, dependency-free JavaScript calculation engine for pay-equity
analysis and salary review. It contains the same pure calculation primitives
used by Novro's pay-mapping and salary-review product, separated from Firebase,
authentication, storage and customer data.

> **Status:** v0.1.0. The API is usable and tested, but may change before 1.0.
> The package supports analysis and decision support; it does not by itself
> produce a legally sufficient filing for any jurisdiction.

## What is included

- FTE-normalised pay and selectable pay basis: base salary, or base salary plus fixed allowances.
- Anonymity-gated gender pay overview.
- Salary-review rule simulation, budget impact and group breakdown.
- Per-currency budget calculations.
- Multi-year correction-plan calculations.
- Effective-dated salary-range matching and position calculations.
- EU pay-transparency quartile, annual, hourly and complementary-pay metrics.
- JSON Schemas and synthetic example data.

The hosted Novro application, Firebase adapters, permissions, workflow state,
email, document storage and deployment configuration are not part of this repo.

## Get started in five minutes

### Requirements

- Node.js 20 or newer
- Git

### Option 1: clone the repository

```bash
git clone https://github.com/jaggeman/novro-pay-equity.git
cd novro-pay-equity
npm ci
npm test
npm run example
```

`npm run example` analyses the synthetic company in
[`examples/synthetic-company.json`](examples/synthetic-company.json) and prints
a pay-equity overview, salary-review budget and EU pay quartiles.

### Option 2: install directly from GitHub

The package is not published to the npm registry yet. Install the current
GitHub release in another Node.js project with:

```bash
npm install github:jaggeman/novro-pay-equity#v0.1.0
```

### Run your first analysis

```js
const Novro = require("@novro/pay-equity-core");

const employees = [
  { EMAIL: "w1@example.test", GENDER: "Female", "BASE SALARY": 40000, "FULL-TIME EQ.": 1, CURRENCY: "SEK" },
  { EMAIL: "w2@example.test", GENDER: "Female", "BASE SALARY": 41000, "FULL-TIME EQ.": 1, CURRENCY: "SEK" },
  { EMAIL: "w3@example.test", GENDER: "Female", "BASE SALARY": 42000, "FULL-TIME EQ.": 1, CURRENCY: "SEK" },
  { EMAIL: "m1@example.test", GENDER: "Male", "BASE SALARY": 44000, "FULL-TIME EQ.": 1, CURRENCY: "SEK" },
  { EMAIL: "m2@example.test", GENDER: "Male", "BASE SALARY": 45000, "FULL-TIME EQ.": 1, CURRENCY: "SEK" },
  { EMAIL: "m3@example.test", GENDER: "Male", "BASE SALARY": 46000, "FULL-TIME EQ.": 1, CURRENCY: "SEK" }
];

const result = Novro.analyzePayEquity(employees, {
  minTeamSize: 3,
  payBasis: "baseSalary"
});

console.log({
  employees: result.totalEmployees,
  womensPayPercentage: result.womensPayPercentage,
  averageSalaryWomen: result.averageSalaryWomen,
  averageSalaryMen: result.averageSalaryMen
});
```

Expected output:

```js
{
  employees: 6,
  womensPayPercentage: 91.1,
  averageSalaryWomen: 41000,
  averageSalaryMen: 45000
}
```

The minimum of three people per reported group is intentional. With fewer
than three women or men, gendered pay figures are returned as `"N/A"` to
protect small groups.

### Use a local clone from code

Inside this repository, replace the package import with:

```js
const Novro = require("./src");
```

Save your example as `my-analysis.js` in the repository root and run:

```bash
node my-analysis.js
```

### Next steps

1. Map your source data to [`schemas/employee.schema.json`](schemas/employee.schema.json).
2. Choose one pay basis and one currency for each analysis population.
3. Read [`docs/privacy-and-anonymity.md`](docs/privacy-and-anonymity.md) before showing results.
4. Use [`docs/integration-guide.md`](docs/integration-guide.md) when connecting storage, authentication or imports.

Common first-run problems:

- `Cannot find module '@novro/pay-equity-core'`: install from GitHub as shown above, or use `require("./src")` inside a clone.
- `womensPayPercentage: "N/A"`: one gender has fewer people with valid salaries than `minTeamSize`.
- Unexpected part-time comparisons: `BASE SALARY` is the actual monthly amount; `FULL-TIME EQ.` accepts `0.8`, `80` or `"80%"` and comparisons are normalised to full-time pay.
- Mixed currencies: split the population by currency or convert it before analysis using a documented reference rate.

## Main APIs

| Need | API |
| --- | --- |
| Pay-equity overview | `Novro.analyzePayEquity(employees, settings, options)` |
| Salary-review simulation | `Novro.salaryRevision.computeRevisionSimulation(employees, rules, options)` |
| Correction-plan phasing | `Novro.correctionPlans.revisionShareForYear(plan, options)` |
| Multi-currency revision budget | `Novro.revisionBudget.budgetByCurrency(input)` |
| Salary-range position | `Novro.salaryRanges.positionInRange(employee, range)` |
| EU pay quartiles and reporting metrics | `Novro.euReporting.*` |

## Usage notes

Disclosure is anonymity-gated by default. `redact: false` must only be used in
a trusted, authorised environment:

```js
Novro.analyzePayEquity(employees, settings, { redact: false });
```

Salary-review simulation:

```js
const simulation = Novro.salaryRevision.computeRevisionSimulation(employees, [
  { scope: "Department", scopeValue: "Engineering", gender: "Female", valueType: "percentage", value: 3 }
]);
```

See [`examples/run.js`](examples/run.js), [`docs/calculations.md`](docs/calculations.md)
and [`docs/integration-guide.md`](docs/integration-guide.md).

## Input contract

The canonical input fields are documented in
[`schemas/employee.schema.json`](schemas/employee.schema.json). Salaries are
actual gross monthly amounts. Aggregate comparisons use full-time-equivalent
pay. A salary and its currency must never be aggregated with another currency
unless the caller has converted both using a documented reference rate.

## Security and privacy

This package performs calculations in memory and has no network, database or
telemetry dependency. The caller remains responsible for access control,
tenant isolation, encryption, retention, audit logging and lawful processing.
Read [`docs/privacy-and-anonymity.md`](docs/privacy-and-anonymity.md) before
exposing results.

## Provenance and licensing

The initial modules were extracted from Novro Engine commit
`cd394daab3ac0d19f14c9510a0b2b8e674a052cd` without its private Git history,
customer data or deployment configuration.

Licensed under **GNU AGPL-3.0-only**. If you run a modified version as a network
service, review the licence's source-offer obligations. Commercial licensing
may be available from the copyright holder; see [`COMMERCIAL.md`](COMMERCIAL.md).

## Contributing

Issues and pull requests are welcome. Every behaviour change needs a regression
test and an explanation of the calculation assumption. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).
