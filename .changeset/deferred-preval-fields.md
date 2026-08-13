---
'@wyw-in-js/processor-utils': patch
'@wyw-in-js/transform': patch
---

Preserve serializable fields of evaluated objects when unrelated nested fields cannot cross the eval IPC boundary, and prioritize processor metadata before treating objects as CSS data. Unsupported nested fields remain strict errors when accessed, while direct unsupported values are still rejected.
