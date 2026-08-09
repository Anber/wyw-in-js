---
'@wyw-in-js/transform': patch
---

Preserve static values and processor replacements when runtime-only component code is removed during evaluation. Separate evaltime and runtime processor paths so removed code cannot poison static analysis, and reuse their shared analysis across both phases.
