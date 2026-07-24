---
'@wyw-in-js/transform': minor
---

Processor manifests can now declare `preeval-call` semantics: the manifest
points at the package's own preeval module and export, and when every call
input is statically known the transform invokes that function with the
resolved arguments — the processor's static value becomes the exact value
the eval path would have produced.

    "semantics": {
      "kind": "preeval-call",
      "module": "./preeval-runtime.js",
      "export": "preevalCss"
    }

This keeps processors with dual-domain values (a runtime class string vs a
structured eval-time descriptor) on a single source of truth instead of
re-encoding their value logic in the engine's declarative vocabulary. The
module resolves relative to the manifest, results must be plain
serializable data, and any load failure, thrown error, or non-serializable
result falls back to the eval path with full diagnostics. Older engines
treat the unknown kind as no semantics and stay on the JS implementation
path.
