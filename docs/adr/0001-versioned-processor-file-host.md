# Versioned synchronous processor file host

Status: Accepted for upstream implementation; no capability is exposed by this
spike.

## Context

`BaseProcessor` receives the transform caller through `IFileContext.filename`
and the configured project root through `IFileContext.root`. Its `build()`
lifecycle is synchronous and returns `void`. The legacy `preeval-call`
manifest target receives only user arguments. A processor can currently use
ambient Node authority to read a caller-relative file, but that read is not
confined by the transform host and does not register a raw-file dependency.

The executable spike in
`packages/transform/src/__tests__/transform.processor-file-host-lifecycle-spike.test.ts`
pins that baseline for both `static` and `execute` strategies:

- caller filename and project root reach the processor instance;
- `build()` is invoked synchronously and a returned thenable is not observed;
- generic processor artifacts survive in transform metadata with empty CSS;
- a processor-owned synchronous raw read does not enter transform
  dependencies.

That last behavior is evidence of the missing host contract, not an approved
implementation technique. The spike is removable once the confined host and
dependency propagation tests replace it.

## Decision

WyW will own a generic, explicitly negotiated capability named
`wyw-processor-file-host-v1`. It will be created per transform invocation and
will not use an ambient global registry, `process.cwd()`, nearest-package
discovery, or processor-owned filesystem access.

The capability will use a host-mediated synchronous read, not an asynchronous
read hidden behind the current `build(): void` lifecycle and not speculative
host preload. The caller-relative descriptor is known only after processor-call
analysis; speculative preload would duplicate processor semantics in the host.
A synchronous host method preserves the existing lifecycle and makes it
impossible to lose a `Promise`.

The eventual capability must carry, at minimum:

- the canonical caller filename;
- explicit canonical `projectRoot` and `readRoots` supplied by the integration;
- a caller-relative specifier and an explicit byte limit for each read;
- a structured byte-exact success or error result;
- the canonical dependency identity registered by a successful read.

The exact TypeScript shape, realpath and symlink containment algorithm, path
portability rules, byte-limit errors, and dependency deduplication belong to the
confined-read and dependency-propagation follow-ups. They must not be inferred
from this spike.

Both `static` and `execute` strategies will receive the same capability and
caller identity. A successful host read will register its canonical raw-file
dependency automatically, including when the processor emits no CSS. Repeated
processor construction or `build()` calls must be idempotent at the dependency
boundary.

Legacy `preeval-call` remains compatible and does not receive this capability.
The later `preeval-call-v1` manifest semantics will require an exact supported
capability version and fail closed before source access when negotiation fails.
No DTCG-specific semantics kind, file-host wire name, or metadata transport will
be added. Existing generic `Artifact[]` remains the processor metadata carrier.

## Consequences

- A source-descriptor processor cannot be activated by this spike.
- Processor-owned `fs` reads remain outside the supported host contract.
- Async file access is not added to `BaseProcessor.build()`.
- Confined read and automatic dependency propagation must land before any
  consumer adapter uses the capability.
- Vite change/delete/rename behavior and `preeval-call-v1` activation remain
  separate qualification work.

## Follow-up ownership

1. `wyw-in-js`: implement caller identity and confined raw-byte read.
2. `wyw-in-js`: propagate successful raw reads as canonical dependencies across
   static, execute, native, and empty-CSS paths.
3. `wyw-in-js`: add generic `preeval-call-v1` and Vite lifecycle semantics.
4. `wyw-in-js`: qualify and freeze the capability version and support matrix.
5. Consumers: negotiate the exact version and keep source-descriptor mode
   fail-closed until the upstream chain is complete.
