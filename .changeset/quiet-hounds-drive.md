---
'@wyw-in-js/nextjs': patch
---

Fix Next.js eval crashes by defaulting `importOverrides` for `react` (and JSX runtimes) so build-time evaluation resolves React via Node instead of Next's vendored RSC runtime.
