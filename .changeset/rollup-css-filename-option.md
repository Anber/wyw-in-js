---
'@wyw-in-js/rollup': patch
---

Add a `cssFilename` option to customize generated virtual CSS filenames in Rollup builds. This lets watch-mode setups use stable CSS ids with CSS bundler plugins that cache transformed CSS by filename.
