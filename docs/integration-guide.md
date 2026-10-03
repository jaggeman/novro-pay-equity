# Integration guide

## Recommended boundary

Validate and scope records in the host application, then pass only the allowed
population into this package. Do not accept an `orgId`, permission flag,
currency or anonymity override directly from an untrusted client.

```js
const { analyzePayEquity } = require("@novro/pay-equity-core");

async function analyseForAuthorisedUser(session, request) {
  const employees = await loadEmployeesInScope(session);
  const persistedSettings = await loadOrganisationSettings(session.orgId);
  return analyzePayEquity(employees, persistedSettings, {
    includeVariablePay: request.includeVariablePay === true,
    redact: session.mayViewUnredactedPay ? false : true
  });
}
```

## Historic calculations

The package does not infer a historic roster. Reconstruct base salary, FTE,
gender, role, job category, inclusion state and recurring components as of the
report's reference date before calling it. Mixing historic variable payments
with today's employee state produces a hybrid result.

## Correction plans

Convert the analysis target back to the unit that will be written to payroll.
For example, if the analysis uses base salary plus allowances and FTE pay:

```text
target actual base salary = target FTE pay × FTE - preserved allowances
```

Freeze the basis, FTE and components used for the conversion so later employee
changes cannot silently reinterpret an existing plan.

## Imports

Use the JSON Schemas as the first validation layer. Add business validation for
unique employee identifiers, supported currency, valid job-category references,
date intervals and maximum row/file size. Validate the complete import before
the first persistent write.
