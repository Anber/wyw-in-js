# WyW v2 migration guide

Full guide: https://wyw-in-js.dev/migration/v2

Key changes:

- WyW packages are ESM-only (`require('@wyw-in-js/*')` no longer works).
- Node.js >= 22 is required for evaluation.
- Evaluation runs in a Node ESM runner; `eval.require` defaults to warn-and-run.
- `@wyw-in-js/babel-preset` still works, but runs eval in a separate Node process.
