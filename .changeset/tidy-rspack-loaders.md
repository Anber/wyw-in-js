---
'@wyw-in-js/nextjs': patch
---

Fix Next.js builds with `next-rspack` by keeping conditional loader selection at the `use` rule level instead of placing a function inside the loader array.
