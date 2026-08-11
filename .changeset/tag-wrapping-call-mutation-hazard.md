---
'@wyw-in-js/transform': patch
---

Preserve static values when a processor tag is wrapped in a class-name combiner such as `cx(css`…`)`. The wrapping call is no longer treated as a mutation hazard for the bindings interpolated inside the tag.
