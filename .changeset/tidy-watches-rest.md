---
'@wyw-in-js/transform': patch
'@wyw-in-js/webpack-loader': patch
---

Fix memory retention in webpack watch mode by clearing completed transform action graphs and avoiding cached loader context references.
