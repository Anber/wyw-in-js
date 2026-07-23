---
'@wyw-in-js/transform': minor
---

Static-first processor pipeline: processor parameters that are statically
analyzable are now computed by the transform and passed to processors
directly, without executing modules at build time.

- The transform builds a per-file static plan before processor scheduling.
  Literals, constant objects, enum-like exports, re-export chains, and
  processor-produced values that can be proven statically are resolved ahead
  of time; everything else falls back to the eval path with unchanged output.
- Processor packages can point a `wyw-in-js.tags` entry at a JSON manifest
  (`{ "version": 1, "name": "...", "implementation": "./processor.js",
  "semantics": { ... } }`). Declarative semantics (`css-template`,
  `styled-target`, `style-object-call`, `css-var-call`,
  `token-contract-call`, `class-name-call`) let the pipeline compute a
  processor's static value — including for imports of that value in other
  files — while the JS processor implementation stays the authoritative
  source of artifacts, diagnostics, and runtime replacement.
- Modules whose processor inputs are fully static are no longer executed
  during evaluation, so their module-level side effects no longer run at
  build time.
- Evaluation results now travel as a single structured `PrevalPayload`. If
  you implement custom workflow handlers: the internal `eval` action now
  yields `PrevalPayload | null` (previously `[ValueCache, string[]] | null`)
  and `collect` receives `{ prevalPayload }` (previously `{ valueCache }`).

Emitted CSS — class-name hashes, selector text, rule content — and
diagnostics are unchanged. Rule declaration order is not guaranteed and may
shift in rare cases.
