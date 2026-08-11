# Processor-owned reads with host dependency registration

Status: Amended after the consumer custom-processor prototype; no new
capability is exposed by this spike.

## Context

`BaseProcessor` already receives the transform caller through
`IFileContext.filename` and the configured project root through
`IFileContext.root`. Its `build()` lifecycle is synchronous and returns `void`.
The executable spike in
`packages/transform/src/__tests__/transform.processor-file-host-lifecycle-spike.test.ts`
pins the current behavior for both `static` and `execute` strategies:

- caller filename and project root reach the processor instance;
- `build()` is invoked synchronously and a returned thenable is not observed;
- generic processor artifacts survive in transform metadata with empty CSS;
- a processor-owned synchronous raw read does not enter transform
  dependencies.

A consumer prototype then proved that these existing custom-processor powers
are sufficient for the DTCG data plane. The processor can validate a static
descriptor, resolve it relative to the caller, confine real paths to the
explicit project root, enforce file and byte limits, read config and token
bytes synchronously, compile them, return a serializable static value, and emit
CSS plus generic metadata artifacts. The same implementation works in the
current `static` and `execute` strategies.

The remaining defect is narrower: the successfully read config and token files
are absent from transform dependencies. Consequently cache invalidation and
watch/HMR cannot react to their change, deletion, or rename.

## Amended decision

WyW will not own a general file-reading capability for this use case. Reading,
specifier policy, project/read-root confinement, realpath and symlink policy,
byte limits, decoding, and domain-specific errors remain processor concerns.
This avoids duplicating consumer semantics in the transform host and avoids
granting new filesystem authority through WyW.

WyW will instead own one generic synchronous effect: a processor can register
an already-resolved raw-file dependency with the current transform. The final
API name and carrier are implementation details, but the contract is equivalent
to:

```ts
registerFileDependency(canonicalAbsolutePath: string): void;
```

The registration contract must:

- reject non-absolute, empty, or malformed identities without consulting
  `process.cwd()`;
- be scoped to the current processor and transform invocation, with no ambient
  global registry;
- accept registration only after the processor has completed its own
  successful read;
- deduplicate repeated registration deterministically;
- preserve the dependency through static, execute, native, and transform-result
  paths, including when the processor emits no CSS;
- participate in cache invalidation and Vite change/delete/rename recovery;
- avoid reading, statting, canonicalizing, or otherwise interpreting the file
  on behalf of the processor.

The processor is responsible for passing the canonical absolute identity that
corresponds to the bytes it read. WyW owns propagation and lifecycle behavior,
not filesystem authority or the consumer's trust policy.

Legacy `preeval-call` remains compatible. Generic `preeval-call-v1` may still be
useful for other processors, but it is no longer a prerequisite for the DTCG
custom processor and must be qualified independently. No DTCG-specific
semantics kind, dependency wire name, or metadata transport will be added.
Existing generic `Artifact[]` remains the processor metadata carrier.

## Consequences

- The DTCG custom processor can be exercised before upstream dependency
  registration lands, provided its draft metadata says dependency tracking is
  unavailable and the package is not released as watch-safe.
- Processor-owned reads remain trusted Node execution and are outside WyW's
  hermetic guarantees.
- Async file access is not added to `BaseProcessor.build()`.
- A raw dependency cannot be registered before or instead of a successful
  consumer-owned read.
- Watch/HMR qualification, minimum supported WyW versions, and consumer
  activation remain blocked on the registration and propagation matrix.

## Follow-up ownership

1. `wyw-in-js`: define the smallest processor dependency-registration API and
   executable lifecycle tests.
2. `wyw-in-js`: propagate registered dependencies through static, execute,
   native, transform-result, cache, and empty-CSS paths.
3. `wyw-in-js`: qualify Vite change/delete/rename invalidation and stale
   metadata/CSS cleanup.
4. `wyw-in-js`: freeze the capability/API version and support matrix.
5. Consumers: keep read/confinement/compile semantics local, register every
   successfully read input, and remove the untracked-dependency marker only
   after the upstream matrix passes.
