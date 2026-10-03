# Architecture

```mermaid
flowchart LR
  HRIS[HRIS / spreadsheet] --> V[Caller-side validation]
  V --> S[JSON Schema records]
  S --> B[Pay-basis and FTE normalisation]
  B --> P[Pay-equity overview]
  B --> E[EU reporting metrics]
  S --> R[Salary-review simulation]
  R --> C[Correction plan and budget]
  S --> G[Salary-range resolution]
```

The package is intentionally a pure calculation boundary. It reads arrays and
objects, returns new arrays and result objects, and performs no I/O. A host
application supplies identity, permissions, tenant scoping, persistence,
currency selection, historic state and export formatting.

`src/index.js` is the stable entry point. The other modules remain available
as subpath exports for consumers that need lower-level primitives.

The public repository contains a snapshot of reviewed source files rather than
the private application's Git history. This prevents application deployment
metadata and unrelated product code from entering the public trust boundary.
