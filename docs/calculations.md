# Calculation reference

## Pay basis and FTE

Input salary is actual gross monthly pay. For comparison:

```text
FTE salary = selected monthly pay basis / employment fraction
```

`FULL-TIME EQ.` accepts a fraction (`0.8`) or percentage (`80`). A missing or
invalid value falls back to `1.0` for the analysis, avoiding an invented
part-time fraction. The selected basis is either:

- `baseSalary`: `BASE SALARY`;
- `baseSalaryAndAllowances`: `BASE SALARY + positive ALLOWANCES`.

Variable pay is included only when the caller explicitly requests it.

## Overview pay gap

The overview compares arithmetic means for employees included in the analysis:

```text
women's pay percentage = mean(FTE pay, women) / mean(FTE pay, men) × 100
gap in percentage points = 100 - women's pay percentage
```

Gender matching for Female and Male is trimmed and case-insensitive. Other
values stay outside the binary comparison but remain part of applicable total
headcount.

## Anonymity

`minTeamSize` has a hard floor of 3. Gendered salary figures are disclosed only
when each gender's usable-salary population reaches the threshold. Group
figures also protect residual/subtraction disclosure. The default is redacted.

## Salary-review rules

Rules run sequentially in array order. Percentage rules multiply the employee's
actual current salary. Flat rules describe a full-time amount and are prorated
by the employee's FTE. Salaries are clamped at zero after every rule.

Budget impact is the sum of simulated minus current actual monthly salary. The
optional Swedish payroll-tax estimate uses the rate exported as
`SR_PAYROLL_TAX_RATE`; callers must verify whether it applies to their case.

## Correction plans

`currentSalary`, `targetSalary` and `monthlyGap` must use the **same unit and
same pay basis**. Do not pass an FTE-normalised target together with actual
part-time base salary. The calculation returns the cumulative floor and any
catch-up required for missed prior shares.

## Multi-currency budgets

`budgetByCurrency` partitions rows before summing. Percent budgets are computed
inside each currency. Flat budgets belong to the primary currency unless the
caller supplies an explicit amount for another currency. Never sum nominal
amounts from different currencies.

## Salary ranges

Ranges are resolved by effective date, currency, dimension and scope. Position
and compa ratio operate on FTE salary. The host must provide an explicit
reference date for historic or future decisions.

## EU metrics

Quartiles rank full-time-equivalent total pay. Ties across a boundary are
distributed proportionally so storage order cannot change the gender split.
Complementary-pay recipient gaps are calculated over recipients; recipient
shares use each gender's whole eligible population. Hourly pay uses recorded
contracted hours when available, otherwise FTE × applicable full-time weekly
hours × 52.

These formulas are implementation documentation, not a conclusion that a
particular report meets every national legal requirement.
