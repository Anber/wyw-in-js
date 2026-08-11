---
'@wyw-in-js/transform': patch
---

Include named and wildcard re-export edges (`export { x } from './y'`, `export * from './y'`) in the eval import map, and compute that map for ignored (verbatim-shipped) modules too instead of always returning `null`. The compiled code for a re-exporting barrel keeps these statements verbatim — a wildcard target can't be selectively pruned without knowing its exports — but the import map built from it previously only tracked `import` declarations. Downstream `only`-merging could silently reuse a narrower cached variant of the re-exported target than the barrel actually needs, dropping exports a consumer reaches only through the barrel.
