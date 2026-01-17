---
'@wyw-in-js/transform': patch
---

Change getTagProcessor.ts > createProcessorInstance to indentify `symbol('skip')` thrown from processors (e.g. linaria) using symbol.description, rather than object identity. This fixes an issue where processors that should have been skipped, instead threw a literal that was never caught.
