---
'@wyw-in-js/transform': minor
'@wyw-in-js/shared': patch
---

Fix shaker keeping unused imports in eval bundles (named/namespace/side-effect imports), which could trigger build-time evaluation crashes (e.g. `@radix-ui/react-tooltip`).

`@wyw-in-js/shared` now passes `importOverrides`/`root` through the evaluator config so the shaker can keep or mock side-effect imports when configured.

Note: eval bundles for `__wywPreval` now drop `import '...';` side-effect imports by default, to avoid executing unrelated runtime code in Node.js during build. If you rely on a side-effect import at eval time, keep it or stub it via `importOverrides`:

- `{ noShake: true }` to keep the import (and disable tree-shaking for that dependency).
- `{ mock: './path/to/mock' }` to redirect the import to a mock module.
