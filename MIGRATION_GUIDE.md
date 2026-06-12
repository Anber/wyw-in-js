# WyW v2 migration guide

Full guide: https://wyw-in-js.dev/migration/v2

Key changes:

- WyW packages are ESM-only (`require('@wyw-in-js/*')` no longer works).
- Node.js >= 22 is required for evaluation.
- Evaluation runs in a Node ESM runner; `eval.require` defaults to warn-and-run.
- `eval.strategy: "hybrid"` is the v2 default and enables static-first value resolution with evaluator fallback; use
  `execute` for evaluator-only compatibility and `static` to reject fallback.
- `eval.globals` changes are respected between runs (value updates and key removals both trigger re-init).
- CSS rule emission order can differ from v1 for equivalent extracted rule sets; make cascade precedence explicit where order ties matter.
- `@wyw-in-js/babel-preset` still works, but runs eval in a separate Node process.
