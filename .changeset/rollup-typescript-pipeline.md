---
'@wyw-in-js/rollup': patch
'@wyw-in-js/transform': patch
---

Allow bundler adapters to provide loaded dependency source during evaluation.

The Rollup adapter now loads resolved dependencies through Rollup before WyW falls back to reading source from disk. This keeps evaluation aligned with earlier Rollup plugins, including TypeScript transforms, when imported values are needed for CSS extraction.
