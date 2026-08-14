---
'@wyw-in-js/processor-utils': minor
'@wyw-in-js/transform': minor
'@wyw-in-js/vite': patch
---

Allow custom processors to register absolute file dependencies and propagate them through transform results.

Vite now watches registered dependencies even when a transform emits no CSS and invalidates dependent modules during HMR.

The Vite plugin now also uses the resolved Vite project root for processor context instead of the process working directory.

Vite metadata now serializes absolute file dependencies as portable project-relative identities while retaining absolute paths for watching and cache invalidation.
