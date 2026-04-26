---
"@wyw-in-js/babel-preset": major
"@wyw-in-js/bun": major
"@wyw-in-js/cli": major
"@wyw-in-js/esbuild": major
"@wyw-in-js/nextjs": major
"@wyw-in-js/parcel-transformer": major
"@wyw-in-js/processor-utils": major
"@wyw-in-js/rollup": major
"@wyw-in-js/shared": major
"@wyw-in-js/transform": major
"@wyw-in-js/turbopack-loader": major
"@wyw-in-js/vite": major
"@wyw-in-js/webpack-loader": major
---

WyW-in-JS packages are now ESM-only and require Node.js >= 22.0.0.

Breaking changes in v2:
- CJS `require()` package entrypoints were removed; migrate configs/tooling to ESM (`import()` / `.mjs`).
- Eval moved to the async ESM runner-based pipeline (`vm.SourceTextModule` + broker RPC), which is now the default path in v2.
- Eval IPC and Babel preset config handling are stricter:
  - unsupported values in `__wywPreval` now fail explicitly instead of being silently coerced through JSON
  - function-valued preset/plugin options are supported when loaded from config files, while inline non-serializable options now error with migration guidance
  - `eval.globals` encoding and invalidation are more predictable and reject unsupported values earlier
- `require()` inside eval now follows fallback semantics controlled by `eval.require` (`warn-and-run` / `error` / `off`).

This release also updates the published bundler integrations, adapter coverage,
and migration/docs around the v2 evaluator contract, and includes cache and
warm-runner reuse fixes to keep the new evaluator on the expected performance
path.

Migration guide: https://wyw-in-js.dev/migration/v2
