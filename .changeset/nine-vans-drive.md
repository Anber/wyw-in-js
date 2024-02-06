---
'@wyw-in-js/transform': minor
---

Keyframes are now scoped by default. This behaviour can be changed by `:global()`: `@keyframes :global(bar) {…}`, `animation-name: :global(bar);`.
