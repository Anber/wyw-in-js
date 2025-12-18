# Vite React Fast Refresh repro

Minimal Vite + React project that triggers `/@react-refresh` resolution when using `@wyw-in-js/vite` with `@vitejs/plugin-react@5.0.3+`.

## Stack

- Node: 20+ (issue originally seen on Node 24)
- Vite: ^5.0.9
- @vitejs/plugin-react: ^5.0.3
- @wyw-in-js/vite: workspace (0.8.x)
- @wyw-in-js/template-tag-syntax: workspace (demo css tag)
- React: ^18.2.0

## Repro

```sh
pnpm install --filter vite-react-refresh-repro...
pnpm --filter vite-react-refresh-repro dev
```

On current `main` before this fix the dev server crashes with:

```
Pre-transform error: ENOENT: no such file or directory, open '/@react-refresh'
Plugin: wyw-in-js
```

After the fix, the project starts and renders a simple box styled via `css`.
