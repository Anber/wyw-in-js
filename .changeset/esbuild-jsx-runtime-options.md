---
"@wyw-in-js/esbuild": patch
---

Preserve esbuild JSX runtime options when transforming TSX before WyW extraction, so automatic JSX runtime builds do not emit bare `React.createElement` calls.
