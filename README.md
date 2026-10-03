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

## Install and run

```bash
npm install
npm test
npm run example
```

When published to npm:

```bash
npm install @novro/pay-equity-core
```

```js
const Novro = require("@novro/pay-equity-core");

const result = Novro.analyzePayEquity(employees, {
  minTeamSize: 3,
  payBasis: "baseSalaryAndAllowances"
});

console.log(result.womensPayPercentage);
```

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
