---
'@wyw-in-js/babel-preset': major
'@wyw-in-js/bun': major
'@wyw-in-js/cli': major
'@wyw-in-js/esbuild': major
'@wyw-in-js/nextjs': major
'@wyw-in-js/parcel-transformer': major
'@wyw-in-js/processor-utils': major
'@wyw-in-js/rollup': major
'@wyw-in-js/shared': major
'@wyw-in-js/transform': major
'@wyw-in-js/turbopack-loader': major
'@wyw-in-js/vite': major
'@wyw-in-js/webpack-loader': major
---

Release WyW-in-JS v2.

The v2 release moves the published packages to an ESM-only, Oxc-backed transform and evaluation pipeline and requires Node.js >= 22.0.0.

Breaking changes and migration notes from v1:

- CommonJS package entrypoints were removed. Migrate configs and tooling to ESM (`import()` / `.mjs`).
- The transform path now uses Oxc for parsing, analysis, pre-evaluation rewrites, shaking, collection, and code generation. `@wyw-in-js/babel-preset` remains available as a deprecated compatibility wrapper around the Oxc pipeline.
- Build-time evaluation now runs through the async ESM evaluator (`vm.SourceTextModule` + runner RPC).
- The default value resolver is `eval.strategy: "hybrid"`: WyW tries static-first resolution for provable values and falls back to evaluator execution for values that still need runtime module evaluation. Use `eval.strategy: "execute"` for evaluator-only compatibility, or `eval.strategy: "static"` to reject evaluator fallback.
- The previous top-level `evaluate` option is replaced by `eval.strategy`.
- Eval IPC and config handling are stricter: unsupported `__wywPreval`, `eval.globals`, and inline non-serializable preset/plugin options now fail with explicit migration errors instead of being silently coerced.
- `require()` inside eval follows the configured `eval.require` fallback behavior (`warn-and-run`, `error`, or `off`).
- CSS rule emission order can differ from v1 for equivalent extracted rule sets because the static-first/Oxc pipeline can process preserved imports and rules in a different order. Projects that rely on cascade ties between generated rules should make precedence explicit in selector specificity, composition, or source structure.

Migration guide: https://wyw-in-js.dev/migration/v2
