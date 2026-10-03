# Privacy and anonymity

Pay data is highly sensitive personal data. This library never sends or stores
records, but embedding it in a service creates obligations for the host.

Minimum integration controls:

1. Authenticate every user and derive tenant scope server-side.
2. Authorise salary access separately from ordinary employee access.
3. Run organisation-wide reports only for organisation-wide grants.
4. Keep raw employee rows out of browser responses when aggregates suffice.
5. Apply the anonymity gate before exporting, caching or sharing a result.
6. Prevent differencing attacks across overlapping filters, entities and years.
7. Encrypt data in transit and at rest and record access in an audit log.
8. Define retention and deletion rules for imports, reports and exports.

The `redact: false` option is intended for a trusted server-side or otherwise
explicitly authorised context. Do not let an untrusted client choose it.

## Know which outputs contain employee rows

`analyzePayEquity` returns aggregates and is anonymity-gated by default.
Lower-level APIs have different purposes and disclosure boundaries:

- `salaryRevision.computeRevisionSimulation` returns `simulatedEmployees`, a
  cloned row for every input employee with the simulated salary. Treat it as
  raw salary data.
- `salaryRanges.positionInRange` returns a position derived from one person's
  salary. Treat it as personal data.
- EU metric builders return aggregate objects, but the host must honour their
  `redacted` fields and must not combine overlapping reports to infer a hidden
  group.

Do not return an entire library result to a browser merely because one field is
redacted. Select the specific aggregate fields that the authorised user needs.

Synthetic examples in this repository do not represent real people or a real
organisation.
