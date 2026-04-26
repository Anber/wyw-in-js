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

Complete the v2 Oxc migration across the core transform and evaluator pipeline.

This cutover moves the runtime transform path to the Oxc-backed implementation, including module analysis, preeval rewrites, dangerous-code removal, processor application, template dependency extraction, shaker, collect, emit, and the async ESM evaluator flow.

The public configuration contract is now Oxc-first, with `oxcOptions`, `EvalRule.oxcOptions`, and the `hybrid` resolver mode available across the updated packages. Processor integrations now rely on the engine-neutral `AstService` surface, and the migration includes cache, concurrency, and hot-path performance fixes needed to keep downstream behavior stable after the cutover.
