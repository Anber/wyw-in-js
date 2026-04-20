# Rsbuild issue #256 scenario

This example captures the module graph shape that reproduced the symptoms from
`wyw#256` before the fix in `processEntrypoint`.

It exercises:

- built JS barrel package consumed through the webpack-loader compatibility path
- narrow `extensions` list that skips plain `.ts`
- many application consumers importing from the same built barrel
- WyW debug output written as structured `jsonl`

## Stack

- Node: 20+
- Rsbuild / Rspack
- `@wyw-in-js/webpack-loader`
- `@wyw-in-js/template-tag-syntax`

## Usage

```sh
bun install
```

### 1. Small scenario

```sh
bun run --filter rsbuild-issue-256-repro build:warnings
```

Expected result on the fixed workspace:

- build succeeds
- no `Unknown import reached during eval` warning storm is emitted
- `wyw-debug/*.jsonl` files are written

On pre-fix builds this same scenario used to trigger the resolver-fallback
warning path. It uses a deliberately small fixture (`8` exports, `2`
consumers), so it stays easy to run while still exercising built-JS barrels.

### 2. Heavy scenario

```sh
bun run --filter rsbuild-issue-256-repro build:oom
```

Expected result on the fixed workspace:

- build succeeds
- memory stays bounded well below the previous heap-OOM path
- `wyw-debug/*.jsonl` files are written

On pre-fix builds this same scenario used to end in heap OOM.

`build` is an alias of the heavy scenario. `build:smoke` is an alias of the
small scenario.

To increase pressure further:

```sh
WYW_REPRO_EXPORTS=600 WYW_REPRO_CONSUMERS=180 bun run --filter rsbuild-issue-256-repro build:oom
```

The build writes WyW debug artifacts into `wyw-debug/`:

- `actions.jsonl`
- `dependencies.jsonl`
- `entrypoints.jsonl`

## What to look for

- root built-JS entrypoints that go straight to `transform` without a preceding
  `explodeReexports` pass when `only` is `["__wywPreval"]`
- absence of `Unknown import reached during eval`, `No resolver found`, and
  heap OOM in the build output
- stable `transform` timings in `actions.jsonl`

The generated fixture aliases `big-barrel-package` to
`fixtures/big-barrel/dist/index.js`, so the app consumes built JS rather than
TypeScript sources.

The key regression guard is that standalone loader roots for the built barrel
still exist, but they should not recursively explode `export *` while they are
processing only `__wywPreval`.
