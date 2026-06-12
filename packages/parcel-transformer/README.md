# `@wyw-in-js/parcel-transformer`

Parcel 2 transformer for `@wyw-in-js/transform`.

## Usage

Prepend `@wyw-in-js/parcel-transformer` to the default JS pipeline in `.parcelrc`:

```json
{
  "extends": "@parcel/config-default",
  "transformers": {
    "*.{js,mjs,jsm,jsx,es6,cjs,ts,tsx}": ["@wyw-in-js/parcel-transformer", "..."]
  }
}
```

## Eval resolver modes

`eval.resolver: 'native'` and the native step of `eval.resolver: 'hybrid'` use `oxc-resolver` with automatic
`tsconfig.json` discovery.

Parcel aliases and resolver plugins are resolved only by the bundler fallback. Use `hybrid` when evaluated imports rely on
Parcel resolver behavior. Use `native` only when `oxc-resolver` can resolve all evaluated imports, or mirror Parcel-only
aliases in `oxcOptions.resolver.alias`.
