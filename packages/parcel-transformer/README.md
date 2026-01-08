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
